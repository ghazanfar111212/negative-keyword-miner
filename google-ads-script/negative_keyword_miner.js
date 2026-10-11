/**
 * NEGATIVE KEYWORD MINER (Google Ads Script)
 *
 * Pulls the search terms report, breaks every search term into 1, 2 and 3 word
 * n-grams, and finds words and phrases that spend without converting.
 * Writes the results to a Google Sheet and optionally posts a summary to Slack.
 *
 * Safety rules built in:
 *   - Never suggests a negative made only of words from your converting searches
 *     (so it will not tell you to block "dental implants" in an implants account)
 *   - Leaves out suggestions that would also block a converting search term
 *   - Removes overlaps: if "free" is suggested, "free dental implants" is dropped
 *
 * Run it inside a single Google Ads account (not the MCC).
 * Search terms from Performance Max are not included (Google does not expose
 * them in this report).
 */

var CONFIG = {
  SHEET_URL: '',            // blank Google Sheet URL (required)
  SLACK_WEBHOOK_URL: '',    // optional

  DATE_RANGE: 'LAST_30_DAYS', // LAST_7_DAYS, LAST_14_DAYS, LAST_30_DAYS, THIS_MONTH, LAST_MONTH
  CAMPAIGN_NAME_CONTAINS: '', // limit to campaigns whose name contains this text

  NGRAM_SIZES: [1, 2, 3],
  MIN_COST: 10,          // minimum spend for an n-gram to be flagged
  MIN_CLICKS: 5,         // minimum clicks for an n-gram to be flagged
  TARGET_CPA: 0,         // set to also flag n-grams with CPA far above target
  CPA_MULTIPLIER: 2,     // flag when CPA is this many times the target
  CORE_SHARE: 0.05,      // words in converting terms with 5%+ of conversions are protected
  PROTECT: []            // words or phrases never to suggest, e.g. ['brand name']
};

var STOPWORDS = toSet(['a', 'an', 'and', 'are', 'at', 'be', 'by', 'for', 'from', 'i', 'in',
  'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'with', 'you', 'your', 'do', 'does',
  'can', 'what', 'how', 'which', 'who', 'where', 'when', 'why']);

function main() {
  if (!CONFIG.SHEET_URL) throw new Error('Set CONFIG.SHEET_URL first.');

  var terms = loadSearchTerms();
  var core = coreTokens(terms);
  var grams = buildNgrams(terms);
  var suggestions = classify(grams, core);
  var covered = markCovered(suggestions);

  var totalCost = 0, wastedCost = 0, wasted = [];
  for (var t in terms) {
    totalCost += terms[t].cost;
    if (terms[t].conversions === 0 && terms[t].cost > 0) {
      wastedCost += terms[t].cost;
      wasted.push([t, terms[t].impressions, terms[t].clicks, round2(terms[t].cost)]);
    }
  }
  wasted.sort(function (a, b) { return b[3] - a[3]; });

  var paste = suggestions.filter(function (s) {
    return s.g.convertingTerms === 0 && !covered[s.gram];
  });

  writeSheet(grams, suggestions, covered, wasted, paste, totalCost, wastedCost);
  if (CONFIG.SLACK_WEBHOOK_URL) postSlack(paste, totalCost, wastedCost);

  Logger.log('Search terms: ' + Object.keys(terms).length + ' | spend with 0 conv: ' +
    round2(wastedCost) + ' | negatives to add: ' + paste.length);
}

function loadSearchTerms() {
  var where = "segments.date DURING " + CONFIG.DATE_RANGE +
    " AND metrics.impressions > 0 AND search_term_view.status != 'EXCLUDED'";
  if (CONFIG.CAMPAIGN_NAME_CONTAINS) {
    where += " AND campaign.name LIKE '%" + CONFIG.CAMPAIGN_NAME_CONTAINS.replace(/'/g, "\\'") + "%'";
  }
  var rows = AdsApp.search(
    'SELECT search_term_view.search_term, metrics.impressions, metrics.clicks, ' +
    'metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
    'FROM search_term_view WHERE ' + where
  );
  var terms = {};
  while (rows.hasNext()) {
    var r = rows.next();
    var term = String(r.searchTermView.searchTerm).toLowerCase().trim();
    if (!terms[term]) terms[term] = { impressions: 0, clicks: 0, cost: 0, conversions: 0, value: 0 };
    var m = terms[term];
    m.impressions += Number(r.metrics.impressions || 0);
    m.clicks += Number(r.metrics.clicks || 0);
    m.cost += Number(r.metrics.costMicros || 0) / 1e6;
    m.conversions += Number(r.metrics.conversions || 0);
    m.value += Number(r.metrics.conversionsValue || 0);
  }
  return terms;
}

function tokenize(term) {
  return term.toLowerCase().match(/[^\s.,!?;:"()\[\]{}\/\\+&|]+/g) || [];
}

function coreTokens(terms) {
  var total = 0, byToken = {};
  for (var t in terms) total += terms[t].conversions;
  if (total === 0) return {};
  for (var term in terms) {
    var conv = terms[term].conversions;
    if (conv === 0) continue;
    var seen = {};
    tokenize(term).forEach(function (tok) {
      if (seen[tok]) return;
      seen[tok] = true;
      byToken[tok] = (byToken[tok] || 0) + conv;
    });
  }
  var core = {};
  for (var tok in byToken) if (byToken[tok] / total >= CONFIG.CORE_SHARE) core[tok] = true;
  return core;
}

function buildNgrams(terms) {
  var grams = {};
  for (var term in terms) {
    var m = terms[term];
    var tokens = tokenize(term);
    var seen = {};
    CONFIG.NGRAM_SIZES.forEach(function (n) {
      for (var i = 0; i + n <= tokens.length; i++) {
        var parts = tokens.slice(i, i + n);
        if (n === 1 && STOPWORDS[parts[0]]) continue;
        if (parts.every(function (p) { return STOPWORDS[p]; })) continue;
        var gram = parts.join(' ');
        if (seen[gram]) continue;
        seen[gram] = true;
        if (!grams[gram]) {
          grams[gram] = { n: n, terms: 0, convertingTerms: 0, impressions: 0, clicks: 0,
            cost: 0, conversions: 0, value: 0 };
        }
        var g = grams[gram];
        g.terms++;
        if (m.conversions > 0) g.convertingTerms++;
        g.impressions += m.impressions;
        g.clicks += m.clicks;
        g.cost += m.cost;
        g.conversions += m.conversions;
        g.value += m.value;
      }
    });
  }
  return grams;
}

function classify(grams, core) {
  var protect = CONFIG.PROTECT.map(function (p) { return p.toLowerCase(); });
  var out = [];
  for (var gram in grams) {
    var g = grams[gram];
    if (protect.some(function (p) { return gram.indexOf(p) !== -1; })) continue;
    if (gram.split(' ').every(function (t) { return core[t] || STOPWORDS[t]; })) continue;
    if (g.cost < CONFIG.MIN_COST || g.clicks < CONFIG.MIN_CLICKS) continue;
    var reason = null;
    if (g.conversions === 0) {
      reason = 'Zero conversions';
    } else if (CONFIG.TARGET_CPA > 0) {
      var cpa = g.cost / g.conversions;
      if (cpa >= CONFIG.TARGET_CPA * CONFIG.CPA_MULTIPLIER) {
        reason = 'CPA ' + cpa.toFixed(2) + ' vs target ' + CONFIG.TARGET_CPA.toFixed(2);
      }
    }
    if (reason) out.push({ gram: gram, g: g, reason: reason });
  }
  out.sort(function (a, b) { return (b.g.cost - a.g.cost) || (a.g.n - b.g.n); });
  return out;
}

function markCovered(suggestions) {
  var safe = suggestions.filter(function (s) { return s.g.convertingTerms === 0; })
    .map(function (s) { return s.gram; });
  var bySize = safe.slice().sort(function (a, b) { return a.split(' ').length - b.split(' ').length; });
  var covered = {};
  bySize.forEach(function (gram) {
    var toks = gram.split(' ');
    for (var i = 0; i < safe.length; i++) {
      var shorter = safe[i];
      if (shorter === gram || covered[shorter]) continue;
      var s = shorter.split(' ');
      if (s.length >= toks.length) continue;
      for (var j = 0; j + s.length <= toks.length; j++) {
        if (toks.slice(j, j + s.length).join(' ') === shorter) {
          covered[gram] = shorter;
          return;
        }
      }
    }
  });
  return covered;
}

function writeSheet(grams, suggestions, covered, wasted, paste, totalCost, wastedCost) {
  var ss = SpreadsheetApp.openByUrl(CONFIG.SHEET_URL);
  var cur = AdsApp.currentAccount().getCurrencyCode();
  var stamp = Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd HH:mm');

  var summary = [
    ['Negative Keyword Miner', ''],
    ['Account', AdsApp.currentAccount().getName()],
    ['Date range', CONFIG.DATE_RANGE],
    ['Last run', stamp],
    ['Total spend (' + cur + ')', round2(totalCost)],
    ['Spend with zero conversions (' + cur + ')', round2(wastedCost)],
    ['Share wasted', totalCost ? wastedCost / totalCost : 0],
    ['Negatives to add', paste.length],
    ['', ''],
    ['Paste-ready negatives (phrase match)', '']
  ].concat(paste.map(function (s) { return ['"' + s.gram + '"', round2(s.g.cost)]; }));
  var sumSheet = writeTab(ss, 'Summary', ['Item', 'Value'], summary.slice(1), summary[0][0]);
  sumSheet.getRange('B8').setNumberFormat('0.0%');

  writeTab(ss, 'Suggested Negatives',
    ['Negative keyword', 'Match type', 'Reason', 'Cost', 'Clicks', 'Conversions',
      'Search terms affected', 'Converting terms affected', 'Already covered by'],
    suggestions.map(function (s) {
      return [s.gram, 'Phrase', s.reason, round2(s.g.cost), s.g.clicks, round2(s.g.conversions),
        s.g.terms, s.g.convertingTerms, covered[s.gram] || ''];
    }));

  var gramRows = Object.keys(grams).map(function (k) {
    var g = grams[k];
    return [k, g.n, g.terms, g.convertingTerms, g.impressions, g.clicks, round2(g.cost),
      round2(g.conversions), g.conversions ? round2(g.cost / g.conversions) : '', round2(g.value)];
  }).sort(function (a, b) { return b[6] - a[6]; });
  writeTab(ss, 'N-grams',
    ['N-gram', 'Words', 'Search terms', 'Converting terms', 'Impressions', 'Clicks', 'Cost',
      'Conversions', 'CPA', 'Conv. value'], gramRows);

  writeTab(ss, 'Wasted Search Terms', ['Search term', 'Impressions', 'Clicks', 'Cost'], wasted);
}

function writeTab(ss, name, headers, rows, title) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var startRow = 1;
  if (title) {
    sh.getRange(1, 1).setValue(title).setFontWeight('bold').setFontSize(14);
    startRow = 2;
  }
  sh.getRange(startRow, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#263238').setFontColor('#FFFFFF');
  sh.setFrozenRows(startRow);
  if (rows.length) {
    var padded = rows.map(function (r) {
      while (r.length < headers.length) r.push('');
      return r.slice(0, headers.length);
    });
    sh.getRange(startRow + 1, 1, padded.length, headers.length).setValues(padded);
  }
  sh.autoResizeColumn(1);
  return sh;
}

function postSlack(paste, totalCost, wastedCost) {
  var cur = AdsApp.currentAccount().getCurrencyCode();
  var lines = [
    '*Negative Keyword Miner* | ' + AdsApp.currentAccount().getName() + ' | ' + CONFIG.DATE_RANGE,
    'Spend with zero conversions: ' + cur + ' ' + round2(wastedCost).toFixed(2) + ' of ' +
      cur + ' ' + round2(totalCost).toFixed(2),
    paste.length + ' negatives ready to add. Top ones:'
  ];
  paste.slice(0, 10).forEach(function (s) {
    lines.push('    • "' + s.gram + '" (' + cur + ' ' + s.g.cost.toFixed(2) + ', ' + s.reason + ')');
  });
  lines.push('<' + CONFIG.SHEET_URL + '|Open full report>');
  UrlFetchApp.fetch(CONFIG.SLACK_WEBHOOK_URL, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ text: lines.join('\n') }), muteHttpExceptions: true
  });
}

function round2(n) { return Math.round(n * 100) / 100; }
function toSet(arr) { var o = {}; arr.forEach(function (x) { o[x] = true; }); return o; }
