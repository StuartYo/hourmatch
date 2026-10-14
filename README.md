# HourMatch

**Renewable certificates issued per plant per hour on a shared ledger, and a checker that tells you whether a green-power claim holds hour by hour.**

Track: Renewable Energy & Energy Trading (IEEE ClimateChain Global Hackathon 2026).

> **Demo data.** Every company, power plant and contract in this repository is fictional. The hourly solar, wind and hydro output curves are real: Taiwan Power Company open data ([data.gov.tw dataset 8931](https://data.gov.tw/dataset/8931), 10-minute snapshots archived by [kiang/taipower_data](https://github.com/kiang/taipower_data)), scaled down to plant size.

## The problem

A company can buy certificates equal to 100% of its yearly electricity use and call itself "100% renewable", even when its factory runs on gas every night. Researchers looked at 115 companies with science-based targets and found that most of their reported Scope 2 cuts in 2015 to 2019 came from certificates rather than real reductions (Bjørn et al., *Nature Climate Change* 12, 2022). The GHG Protocol put hourly matching up for public consultation in 2025 for exactly this reason.

In Taiwan, a renewable certificate (T-REC) covers 1,000 kWh and records no hour at all.

## What HourMatch does

1. **Hourly certificates.** A Solidity contract issues one certificate id per plant per hour (1 unit = 1 kWh) from metered output.
2. **Retire once, same hour only.** A holder can retire a certificate only against the same hour's metered consumption, only once, and never above what that hour used. A plant cannot sell the same hour twice: the transfer reverts.
3. **Claim check.** Paste a sentence such as *"Northbay Fab ran on 100% renewable electricity this week."* A language model turns it into fields (company, dates, hours, claimed %, hourly or volume basis, RE100). Code then computes the real share from the ledger and returns a verdict and a sentence the ledger supports.
4. **Anyone can re-check.** `matchedBps(consumer, from, to)` is a public read. `anchorClaim` stores a claim hash together with a share computed by the contract itself.

On the demo week (6 to 12 October 2026): Northbay Fab's certificates cover **103%** of its use on paper, but only **83.0%** was matched in the same hour. On the held-out week (22 to 28 September, less wind) the same setup reaches only **65.4%**.

## Why code decides and the model only reads

See `eval/RESULTS.md`. Same model, same claims. The model alone gets the full hourly table and the exact matching rules in its prompt. HourMatch lets the model fill in fields and leaves the arithmetic and the verdict to code.

## Why a blockchain and not a database

- **One retirement state across issuers.** A certificate body, a plant selling directly to a factory and a utility reselling green power each keep their own books today. One shared contract holds the only "retired" flag.
- **Public recomputation.** Any auditor, NGO or customer can recompute a claim without an account.
- **Claims cannot be edited later.** The anchored share is computed on chain, not supplied by the company.

Limit: if one national registry published hourly certificates with open read access, it could do most of this without a chain.

## Repository

| Path | What |
|---|---|
| `contracts/HourlyCertificateRegistry.sol` | The registry contract |
| `src/ledger.mjs` | Same rules in JavaScript, so the web demo runs without a chain |
| `test/registry.test.cjs` | Contract tests, plus a replay of the whole demo week (1,376 ledger writes) on the contract, compared with the JavaScript ledger hour by hour |
| `src/scenario.mjs` | Builds the fictional demo week from the real Taipower curves |
| `src/checker.mjs` | Deterministic claim checker |
| `src/parse.mjs`, `src/llm.mjs` | Sentence to fields (OpenAI-compatible API) |
| `eval/` | Claims, evaluation script, results |
| `scripts/fetch_taipower.py` | Downloads and aggregates the Taipower data |
| `scripts/deploy.cjs` | Testnet deployment of one demo day |
| `public/` | The web demo (static) |

## Run it

```bash
npm install
npx hardhat test                 # contract tests + consistency replay
node scripts/build_web.mjs       # copy engine and data into public/
python -m http.server 5178 -d public
```

Evaluation (needs `LLM_API_KEY` or `APERTUS_API_KEY` in your environment; default endpoint is PublicAI's free Apertus inference):

```bash
node eval/run_eval.mjs dev both
node eval/run_eval.mjs holdout both
```

Testnet deployment (testnet only; the key is read from your environment, never from a file):

```bash
npx hardhat run scripts/deploy.cjs --network baseSepolia
```

## Rules in the checker

- A certificate counts only against use in the same hour.
- Hour-by-hour share = sum of min(use, same-hour certificates) / sum of use.
- Volume share = certificates bought / use, only for claims that explicitly talk about certificate volume.
- RE100 (2025 technical criteria): plants commissioned more than 15 years ago do not count.
- A claim is supported if it is at most 0.5 percentage points above the relevant share.

## Data sources

- Taiwan Power Company, real-time generation by unit (data.gov.tw/dataset/8931); history archived at github.com/kiang/taipower_data.
- Bjørn, Lloyd, Brander, Matthews (2022). Renewable energy certificates threaten the integrity of corporate science-based targets. *Nature Climate Change* 12, 539 to 546.
- GHG Protocol, Scope 2 public consultation on hourly matching and deliverability (2025).

## License

MIT
