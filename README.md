# Negative Keyword Miner

Finds the words and phrases in your Google Ads search terms that spend money without converting, and gives you a clean, paste-ready negative keyword list.

Reviewing search terms one by one misses patterns. "free dental implants", "dental implants free for seniors" and "dental school implants free" each look small on their own, but together "free" might be your single biggest source of waste. This tool breaks every search term into 1, 2 and 3 word n-grams, adds up cost and conversions for each, and shows you exactly which words are burning budget.

Two versions:

- **Google Ads Script** (`google-ads-script/`): runs inside the account, writes to a Google Sheet, optional Slack summary. Free and can run on a schedule.
- **Python CLI** (`python/`): works on any exported Search terms report CSV. Good for client accounts where you can't add scripts.

## Example

Running the Python version on the included sample (a dental implants account, 29 search terms):

```
$ python ngram_miner.py sample_search_terms.csv --target-cpa 40 --min-cost 20

Search terms analysed: 29
Total spend:           3,236.75
Spend with 0 conv:     1,077.65 (33.3%)
Negatives suggested:   75 (16 after removing overlaps)

N-gram                                Cost  Clicks  Conv  Reason
cheap                               416.40      76     1  CPA 416.40 vs target 40.00
free                                308.75      53     0  Zero conversions
cheap dental                        265.80      47     0  Zero conversions
cheap dentist                       150.60      29     1  CPA 150.60 vs target 40.00
jobs                                120.20      25     0  Zero conversions
dentures                            120.10      23     0  Zero conversions
...
```

Paste-ready output (`negatives_paste.txt`):

```
"free"
"cheap dental"
"jobs"
"dentures"
"seniors"
"reddit"
"course"
"diy"
...
```

## How it decides what to suggest

1. **N-gram analysis.** Every search term is split into 1, 2 and 3 word phrases. Each phrase gets the combined impressions, clicks, cost and conversions of every search term that contains it. Common filler words (for, the, how, and so on) are not suggested on their own.

2. **Flags.** A phrase is flagged when it has spent at least `min cost` with at least `min clicks` and either has zero conversions, or (if you set a target CPA) a CPA several times above target.

3. **Core word protection.** Words that appear in search terms producing a meaningful share of your conversions are treated as core. A suggestion must contain at least one non-core word. This stops the tool from telling an implants advertiser to block "dental implant" just because some unrelated "dental implant jobs" searches wasted money.

4. **Converting term check.** If a phrase also appears in a search term that converted, it is listed in the report for review but left out of the paste-ready list.

5. **Overlap removal.** A phrase match negative like "free" already blocks "free dental implants", so the longer one is marked as covered and dropped from the paste list. You add the fewest negatives needed.

Always review before adding. The tool finds patterns; you know the business. "cheap" might be waste for a premium clinic and a buying signal for a budget one.

## Python CLI

Requires Python 3.8+. No extra packages.

**Export the report:** in Google Ads, go to Insights and reports > Search terms, choose your date range, and download as CSV. Make sure the Cost, Clicks, Impr. and Conversions columns are included.

```bash
cd python
python ngram_miner.py path/to/search_terms.csv
```

| Option | Default | Description |
|---|---|---|
| `--min-cost` | 10 | Minimum spend for a phrase to be flagged |
| `--min-clicks` | 5 | Minimum clicks for a phrase to be flagged |
| `--target-cpa` | off | Also flag phrases with CPA far above this |
| `--cpa-multiplier` | 2 | How many times the target CPA counts as "far above" |
| `--ngram` | 1 2 3 | N-gram sizes to analyse |
| `--protect` | none | Words or phrases never to suggest, such as your brand |
| `--core-share` | 0.05 | Words in converting terms with this share of conversions are protected |
| `--out` | output | Output folder |

Output files:

| File | Contents |
|---|---|
| `negatives_paste.txt` | Final list in phrase match format, ready to paste |
| `suggested_negatives.csv` | Every flagged phrase with reason, cost, affected terms and overlaps |
| `ngrams.csv` | Full n-gram table, sorted by cost |
| `wasted_search_terms.csv` | Individual search terms with spend and zero conversions |

## Google Ads Script

1. Create a blank Google Sheet and copy its URL.
2. In the Google Ads account (not the MCC), go to Tools > Bulk actions > Scripts and create a new script.
3. Paste `google-ads-script/negative_keyword_miner.js`, set `SHEET_URL` and adjust the settings at the top.
4. Authorize, then Preview.
5. Schedule weekly if you want a fresh list every Monday.

The sheet gets four tabs: **Summary** (spend figures plus the paste-ready list), **Suggested Negatives**, **N-grams** and **Wasted Search Terms**. Add a Slack webhook URL to get the top suggestions posted as a message.

## Limitations

- Performance Max search terms are not available in the search terms report, so PMax waste is not covered.
- Search terms with very low volume may be hidden by Google for privacy, so the report never shows 100% of spend.
- Phrase match negatives do not block close variants of themselves (for example plurals), so you may occasionally need both forms.

## License

MIT
