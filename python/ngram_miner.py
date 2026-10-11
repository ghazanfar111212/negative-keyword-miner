#!/usr/bin/env python3
"""
Negative Keyword Miner (CSV version)

Reads a Google Ads Search terms report export, breaks every search term into
1, 2 and 3 word n-grams, and finds the words and phrases that spend money
without converting. Outputs CSVs plus a paste-ready negative keyword list.

Usage:
    python ngram_miner.py search_terms.csv
    python ngram_miner.py search_terms.csv --target-cpa 40 --min-cost 20 --protect "smile dental"
"""

import argparse
import csv
import os
import re
import sys
from collections import defaultdict

STOPWORDS = {
    "a", "an", "and", "are", "at", "be", "by", "for", "from", "i", "in", "is",
    "it", "my", "of", "on", "or", "the", "to", "with", "you", "your", "do",
    "does", "can", "what", "how", "which", "who", "where", "when", "why",
}

# Column names as they appear in Google Ads exports (lowercased), first match wins
COLUMN_ALIASES = {
    "term": ["search term", "search terms", "query"],
    "impressions": ["impr.", "impressions", "impr"],
    "clicks": ["clicks"],
    "cost": ["cost", "spend"],
    "conversions": ["conversions", "conv.", "all conv."],
    "value": ["conv. value", "conversion value", "conversions value", "all conv. value"],
    "status": ["added/excluded", "status"],
    "campaign": ["campaign"],
}


def parse_number(raw):
    """Turn '1,234.56', 'USD 12.30', '--' or '' into a float."""
    if raw is None:
        return 0.0
    s = str(raw).strip()
    if s in ("", "--", " --"):
        return 0.0
    s = re.sub(r"[^0-9.\-]", "", s.replace(",", ""))
    try:
        return float(s) if s not in ("", "-", ".") else 0.0
    except ValueError:
        return 0.0


def read_report(path):
    """Read a Google Ads export, skipping the title rows above the real header."""
    with open(path, encoding="utf-8-sig", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        delimiter = "\t" if sample.count("\t") > sample.count(",") else ","
        rows = list(csv.reader(f, delimiter=delimiter))

    header_idx = None
    for i, row in enumerate(rows[:20]):
        lowered = [c.strip().lower() for c in row]
        if any(c in COLUMN_ALIASES["term"] for c in lowered):
            header_idx = i
            break
    if header_idx is None:
        sys.exit("Could not find a 'Search term' column. Export the Search terms report from Google Ads.")

    header = [c.strip().lower() for c in rows[header_idx]]
    col = {}
    for key, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            if alias in header:
                col[key] = header.index(alias)
                break
    for required in ("term", "clicks", "cost", "conversions"):
        if required not in col:
            sys.exit(f"Missing required column: {required}. Found columns: {rows[header_idx]}")

    terms = defaultdict(lambda: {"impressions": 0.0, "clicks": 0.0, "cost": 0.0,
                                 "conversions": 0.0, "value": 0.0, "excluded": False})
    for row in rows[header_idx + 1:]:
        if len(row) <= col["term"]:
            continue
        term = row[col["term"]].strip().lower()
        if not term or term.startswith("total"):
            continue
        t = terms[term]
        for key in ("impressions", "clicks", "cost", "conversions", "value"):
            if key in col and col[key] < len(row):
                t[key] += parse_number(row[col[key]])
        if "status" in col and col["status"] < len(row):
            if row[col["status"]].strip().lower() == "excluded":
                t["excluded"] = True
    return terms


def tokenize(term):
    return re.findall(r"[\w']+", term.lower(), flags=re.UNICODE)


def build_ngrams(terms, sizes):
    grams = defaultdict(lambda: {"n": 0, "impressions": 0.0, "clicks": 0.0, "cost": 0.0,
                                 "conversions": 0.0, "value": 0.0, "terms": 0,
                                 "converting_terms": 0})
    for term, m in terms.items():
        if m["excluded"]:
            continue
        tokens = tokenize(term)
        seen = set()
        for n in sizes:
            for i in range(len(tokens) - n + 1):
                gram_tokens = tokens[i:i + n]
                if n == 1 and gram_tokens[0] in STOPWORDS:
                    continue
                if all(t in STOPWORDS for t in gram_tokens):
                    continue
                gram = " ".join(gram_tokens)
                if gram in seen:
                    continue  # count each search term once per n-gram
                seen.add(gram)
                g = grams[gram]
                g["n"] = n
                g["terms"] += 1
                if m["conversions"] > 0:
                    g["converting_terms"] += 1
                for key in ("impressions", "clicks", "cost", "conversions", "value"):
                    g[key] += m[key]
    return grams


def core_tokens(terms, share):
    """Words that appear in search terms producing a meaningful share of conversions.
    A suggested negative must contain at least one word that is NOT core, so the tool
    never suggests blocking your main keywords (for example 'dental implant')."""
    total = sum(m["conversions"] for m in terms.values() if not m["excluded"])
    if total == 0:
        return set()
    by_token = defaultdict(float)
    for term, m in terms.items():
        if m["excluded"] or m["conversions"] == 0:
            continue
        for tok in set(tokenize(term)):
            by_token[tok] += m["conversions"]
    return {tok for tok, conv in by_token.items() if conv / total >= share}


def classify(grams, args, protected, core):
    suggestions = []
    for gram, g in grams.items():
        if any(p in gram for p in protected):
            continue
        if all(tok in core or tok in STOPWORDS for tok in gram.split()):
            continue
        if g["cost"] < args.min_cost or g["clicks"] < args.min_clicks:
            continue
        reason = None
        if g["conversions"] == 0:
            reason = "Zero conversions"
        elif args.target_cpa:
            cpa = g["cost"] / g["conversions"]
            if cpa >= args.target_cpa * args.cpa_multiplier:
                reason = f"CPA {cpa:.2f} vs target {args.target_cpa:.2f}"
        if reason:
            suggestions.append((gram, g, reason))
    # Longer phrases first when cost is similar, so you add the precise negative, not a broad word
    suggestions.sort(key=lambda x: (-x[1]["cost"], x[1]["n"]))
    return suggestions


def mark_covered(suggestions):
    """A phrase negative like "free" already blocks "free dental implants".
    Returns {gram: covering_gram} for suggestions made redundant by a shorter one."""
    safe = [g for g, d, _ in suggestions if d["converting_terms"] == 0]
    covered = {}
    for g in sorted(safe, key=lambda x: len(x.split())):
        toks = g.split()
        for shorter in safe:
            if shorter == g or shorter in covered:
                continue
            s = shorter.split()
            if len(s) < len(toks) and any(toks[i:i + len(s)] == s for i in range(len(toks) - len(s) + 1)):
                covered[g] = shorter
                break
    return covered


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def main():
    p = argparse.ArgumentParser(description="Find wasted spend in Google Ads search terms with n-gram analysis.")
    p.add_argument("report", help="Search terms report export (CSV or TSV)")
    p.add_argument("--min-cost", type=float, default=10, help="Minimum spend for an n-gram to be flagged (default 10)")
    p.add_argument("--min-clicks", type=float, default=5, help="Minimum clicks for an n-gram to be flagged (default 5)")
    p.add_argument("--target-cpa", type=float, default=0, help="Your target CPA. Also flags n-grams with CPA far above it")
    p.add_argument("--cpa-multiplier", type=float, default=2.0, help="Flag when CPA is this many times the target (default 2)")
    p.add_argument("--ngram", type=int, nargs="+", default=[1, 2, 3], help="N-gram sizes (default 1 2 3)")
    p.add_argument("--protect", nargs="*", default=[], help="Words or phrases never to suggest, such as brand names")
    p.add_argument("--core-share", type=float, default=0.05,
                   help="Words in converting terms with at least this share of conversions are never "
                        "suggested on their own (default 0.05 = 5%%)")
    p.add_argument("--out", default="output", help="Output folder (default ./output)")
    args = p.parse_args()

    terms = read_report(args.report)
    if not terms:
        sys.exit("No search terms found in the report.")
    protected = [x.lower() for x in args.protect]
    grams = build_ngrams(terms, args.ngram)
    core = core_tokens(terms, args.core_share)
    suggestions = classify(grams, args, protected, core)
    covered = mark_covered(suggestions)
    os.makedirs(args.out, exist_ok=True)

    # All n-grams
    write_csv(os.path.join(args.out, "ngrams.csv"),
              ["N-gram", "Words", "Search terms", "Converting terms", "Impressions", "Clicks",
               "Cost", "Conversions", "CPA", "Conv. value"],
              [[g, d["n"], d["terms"], d["converting_terms"], int(d["impressions"]), int(d["clicks"]),
                round(d["cost"], 2), round(d["conversions"], 2),
                round(d["cost"] / d["conversions"], 2) if d["conversions"] else "",
                round(d["value"], 2)]
               for g, d in sorted(grams.items(), key=lambda x: -x[1]["cost"])])

    # Suggested negatives
    write_csv(os.path.join(args.out, "suggested_negatives.csv"),
              ["Negative keyword", "Match type", "Reason", "Cost", "Clicks", "Conversions",
               "Search terms affected", "Converting terms affected", "Already covered by"],
              [[g, "Phrase", reason, round(d["cost"], 2), int(d["clicks"]), round(d["conversions"], 2),
                d["terms"], d["converting_terms"], covered.get(g, "")] for g, d, reason in suggestions])

    # Paste-ready list (phrase match format for the Google Ads negative keyword box)
    with open(os.path.join(args.out, "negatives_paste.txt"), "w", encoding="utf-8") as f:
        paste = [g for g, d, _ in suggestions if d["converting_terms"] == 0 and g not in covered]
        for g in paste:
            f.write(f"\"{g}\"\n")

    # Individual wasted search terms
    wasted = [(t, m) for t, m in terms.items()
              if not m["excluded"] and m["conversions"] == 0 and m["cost"] > 0]
    wasted.sort(key=lambda x: -x[1]["cost"])
    write_csv(os.path.join(args.out, "wasted_search_terms.csv"),
              ["Search term", "Impressions", "Clicks", "Cost"],
              [[t, int(m["impressions"]), int(m["clicks"]), round(m["cost"], 2)] for t, m in wasted])

    total_cost = sum(m["cost"] for m in terms.values())
    wasted_cost = sum(m["cost"] for _, m in wasted)
    share = (wasted_cost / total_cost * 100) if total_cost else 0

    print(f"\nSearch terms analysed: {len(terms)}")
    print(f"Total spend:           {total_cost:,.2f}")
    print(f"Spend with 0 conv:     {wasted_cost:,.2f} ({share:.1f}%)")
    print(f"Negatives suggested:   {len(suggestions)} ({len(paste)} after removing overlaps)\n")
    top = [s for s in suggestions if s[0] not in covered]
    if top:
        print(f"{'N-gram':<32}{'Cost':>10}{'Clicks':>8}{'Conv':>6}  Reason")
        for g, d, reason in top[:15]:
            print(f"{g[:31]:<32}{d['cost']:>10.2f}{int(d['clicks']):>8}{d['conversions']:>6.0f}  {reason}")
    risky = [g for g, d, _ in suggestions if d["converting_terms"] > 0]
    if risky:
        print(f"\nCareful: {len(risky)} suggestion(s) also appear in converting search terms "
              f"and were left out of negatives_paste.txt. Review them in suggested_negatives.csv.")
    print(f"\nFiles written to {args.out}/")


if __name__ == "__main__":
    main()
