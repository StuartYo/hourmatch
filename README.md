# HourMatch

**Renewable certificates issued per plant per hour on a shared ledger, and a checker that tells you whether a green-power claim holds hour by hour.**

Track: Renewable Energy & Energy Trading (IEEE ClimateChain Global Hackathon 2026). Live demo: https://hourmatch.vercel.app

> **Demo data.** Every company, power plant, contract and wallet in this repository is fictional. The hourly solar, wind and hydro output curves are real: Taiwan Power Company open data ([data.gov.tw dataset 8931](https://data.gov.tw/dataset/8931), 10-minute snapshots archived by [kiang/taipower_data](https://github.com/kiang/taipower_data)), scaled down to plant size.
>
> **Designed for the demo.** Each company's certificate volume was set on purpose to a little over its use (Northbay Fab 103%, Harbor Office 105%, Cloudline Data Center 104%; `VOLUME_RATIO` in `src/scenario.mjs`), so that "100% renewable" is true on paper. The hour-by-hour shares are not tuned; they come from the real Taipower curves.

## The problem

A company can buy certificates equal to 100% of its yearly electricity use and call itself "100% renewable", even when its factory runs on gas every night. Researchers looked at 115 companies with science-based targets and found that most of their reported Scope 2 cuts in 2015 to 2019 came from certificates rather than real reductions (Bjørn et al., *Nature Climate Change* 12, 2022). The GHG Protocol put hourly matching up for public consultation in 2025 for this reason.

In Taiwan, a renewable energy certificate (T-REC) is issued per 1,000 kWh and records no hour (see Taiwan context below).

## What HourMatch does

1. **Hourly certificates from several issuers.** The operator authorizes issuers (`addIssuer`, `removeIssuer`). Each issuer registers its own plants and issues one certificate id per plant per hour (1 unit = 1 kWh). Every plant-hour can be issued once (`AlreadyIssued`), and only by the issuer that registered the plant (`NotGeneratorIssuer`).
2. **One shared retirement state.** Certificates from every issuer count against the same `matched` counter for a company and hour. A kWh retired through Issuer A cannot be claimed again through Issuer B.
3. **Transfer once.** Only the plant account can transfer, so a certificate changes hands at most once, plant to buyer (`OnlyOneTransfer`). This follows the T-REC rule that a certificate is transferred once in principle.
4. **Companies bound to wallets.** The operator binds each company id to one wallet. Only that wallet can retire certificates against the company's metered use (`NotConsumerWallet`), only in the same hour (`HourMismatch`), never above that hour's use (`ExceedsUnmatchedConsumption`).
5. **Claim check.** Paste a sentence such as *"Northbay Fab ran on 100% renewable electricity this week."* It is turned into fields (company, dates, hours, claimed %, hourly or volume basis, RE100). Code computes the share from the ledger, gives a verdict, and writes a sentence the ledger supports on the same basis.
6. **Your own data.** Upload an hourly use CSV and a certificate CSV. Everything is computed in the browser; nothing is uploaded. The result can be printed or saved as a one-page PDF report. Sample files are on the page.
7. **Anyone can re-check.** `matchedBps(company, from, to)` is a public read; the page has a button that reads it from Sepolia and shows it next to the browser's own number. A company can anchor the hash of its own claim with `anchorClaim`; the share stored with it is computed by the contract.

On the demo week (6 to 12 October 2026): Northbay Fab's certificates cover **103.0%** of its use on paper, but only **83.0%** was matched in the same hour. On the held-out week (22 to 28 September, less wind) the same setup reaches **65.4%**.

### Where the AI is, and where it is not

No AI model runs on the web page. The five example sentences on the page were parsed into fields in advance by `aisingapore/Qwen-SEA-LION-v4-32B-IT` (PublicAI free inference, temperature 0) during the evaluation run on 14 October 2026, 14:20 UTC; the page shows that cached output and says so. Sentences a visitor types are read by keyword rules in the browser (`src/ruleparse.mjs`). The rules report an error for a company that is not in the ledger, for a time window that crosses midnight or does not start on a full hour, and for a missing percentage, instead of guessing. Every number and every verdict comes from code.

## On chain (Ethereum Sepolia testnet)

Contract [`0xcA60934442d09fc62F7CEd7B424a2939ea89D4d6`](https://sepolia.etherscan.io/address/0xcA60934442d09fc62F7CEd7B424a2939ea89D4d6), chain id 11155111. Source verified on [Sourcify](https://repo.sourcify.dev/11155111/0xcA60934442d09fc62F7CEd7B424a2939ea89D4d6) (exact match).

One demo day (8 October 2026) is written on chain with **six separate test wallets**: operator, Issuer A (Sunfield Solar, Old Creek Hydro), Issuer B (Strait Wind), and one wallet each for Northbay Fab, Harbor Office and Cloudline Data Center. The other six days of the week exist only in the browser ledger; `test/registry.test.cjs` replays the whole week on the contract and compares every day with the JavaScript ledger.

| Step on 8 October | Wallet | Result |
|---|---|---|
| Issuer A issues 24 hourly ids for Sunfield Solar and for Old Creek Hydro; Issuer B for Strait Wind | issuers | done |
| A company wallet tries to issue certificates | Northbay Fab | refused, `NotIssuer` |
| Issuer B tries to issue for Issuer A's plant | Issuer B | refused, `NotGeneratorIssuer` |
| Issuer A issues the same day again | Issuer A | refused, `AlreadyIssued` |
| Plant accounts sell hourly certificates to the three companies (4 transfers) | issuers | done |
| Strait Wind sells an already sold hour again | Issuer B | refused, `InsufficientBalance` |
| Northbay resells a certificate it bought | Northbay Fab | refused, `OnlyOneTransfer` |
| Each company retires same-hour certificates from its own wallet | companies | done |
| Cloudline's wallet tries to retire Northbay's certificates for Northbay | Cloudline | refused, `NotConsumerWallet` |
| Cloudline's wallet tries to retire Northbay's certificates for itself | Cloudline | refused, `InsufficientBalance` |
| Northbay retires again for an hour already fully matched | Northbay Fab | refused, `ExceedsUnmatchedConsumption` |
| Cloudline's wallet tries to anchor a claim about Northbay | Cloudline | refused, `NotConsumerWallet` |
| Northbay anchors its own claim; the contract stores 82.8% | Northbay Fab | done |

All hashes are in `deployments/sepolia.json`. `node scripts/verify_chain.mjs` re-reads every receipt from a public RPC and checks its status, and checks `matchedBps` against the JavaScript ledger. The earlier single-wallet contract `0x5Fd952504449Cf291FBFAe6CBe9daaa1CE5Ecf18` is superseded (`deployments/archive/sepolia_v1.json`).

### Gas, measured on Sepolia

Gas used per transaction, from the Sepolia receipts of 15 October 2026 (one day = 24 hours):

| Call | Gas |
|---|---|
| Deploy | 11,277,653 |
| `issueBatch`, one plant, one day (24 hours with output) | 5,383,537 |
| `issueBatch`, one solar plant, one day (13 hours with output) | 2,929,326 |
| `recordConsumption`, one company, one day | 2,733,234 |
| `transferBatch`, 24 hourly ids | 2,889,508 to 3,040,516 |
| `retireBatch`, 35 hourly ids | 6,845,816 |
| `anchorClaim` | 246,890 |
| Refused calls | 21,400 to 72,600 |

All writes for the demo day (3 plants, 3 companies, 4 sales, 3 retirements, 1 anchor): **50,302,884 gas**, about 0.00005 test ETH at the 0.001 gwei Sepolia price of that day. For comparison, a local Hardhat node reports about a quarter of these figures for the same calls (`npx hardhat test` prints them); the numbers above are the ones Sepolia charged. At this cost a year of hourly data for many plants would not belong on Ethereum mainnet. A production version would write hourly data to a rollup or a permissioned chain, or anchor a daily Merkle root and keep the hourly rows off chain.

## Trust model

- Once a transaction is in a block, nobody can edit or delete it, including the operator. The contract has no function that changes a balance, a retirement or an anchored record after the fact, and it is not upgradeable.
- The operator chooses the issuers and writes metered use. Wrong meter data gives a wrong share. A correction is a public event and can never go below what is already matched. In a real system meter data would come from the grid operator and the issuer list would be under multi-party control.
- Only the wallet bound to a company can retire or anchor for it; the binding is set by the operator.
- Sepolia is a test network. The contract is a prototype, not audited, and has no legal standing next to Taiwan's official registry.
- Limit: if one national registry published hourly certificates with open read access, it could do most of this without a chain.

## Taiwan context

The interface is in English for an international jury; the page has a bilingual glossary. Current rules: [Implementation Regulations Governing Renewable Energy Certificates](https://law.moj.gov.tw/ENG/LawClass/LawAll.aspx?pcode=J0100073) ([再生能源憑證實施辦法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=J0100073), amended 26 May 2025, in force 1 July 2025), administered by the [National Renewable Energy Certification Center](https://www.trec.org.tw/) (國家再生能源憑證中心) of the Bureau of Standards, Metrology and Inspection (經濟部標準檢驗局).

| | T-REC today | HourMatch demo |
|---|---|---|
| Certificate size | 1,000 kWh, no hour (Art. 5) | 1 kWh per plant per hour |
| When it can be used | For its generation year (Art. 8) | Only against use in the same hour |
| Transfers | Once in principle; exceptions with the Center's approval (Art. 7) | Exactly once, plant to buyer; no exception path |
| Wheeling (轉供) and direct supply (直供) | Certificates transferred must match the supplied volume (Art. 7) | Same-hour matching is a stricter, hourly version |
| Self-generation (自發自用, now 再生能源自用發電設備) | Unused certificates may be transferred (Art. 7) | Not modelled separately |
| Retirement (註銷; in the regulation: registering use or declaration) | Registered with the Center within two months; used certificates cannot be transferred (Art. 8) | Immediate and public, from the company's own wallet |

## Rules in the checker

- A certificate counts only against use in the same hour.
- Hour-by-hour share = sum of min(use, same-hour certificates) / sum of use.
- Volume share = certificates bought / use, only for claims that explicitly talk about certificate volume.
- A claim is supported if it is at most 0.5 percentage points above the share on its basis. Percentages are shown rounded to one decimal (the contract keeps basis points, rounded down).
- RE100 ([Technical Criteria, 24 March 2025](https://www.there100.org/technical-guidance), section 4.2): projects must be commissioned or re-powered on or after 1 January of the year fifteen years before the claim year (2011 or later for a 2026 claim); up to 15% of total use may come from older projects. Unknown commission years count as old. Exempt procurement types (self-generation, on-site or direct-line PPAs, long-term project-specific contracts held by the original off-taker, default delivered renewable electricity, contracts that began before 1 January 2024) are not modelled.

## Evaluation

See `eval/RESULTS.md`. 18 claims about the demo week and 8 about a held-out week.

| Setup | Demo week | Held-out week |
|---|---|---|
| HourMatch (model fills fields, code decides) | 17 / 18 | 8 / 8 |
| Same model alone, with the hourly table and rules in its prompt | 13 / 18 | 3 / 8 |
| Spreadsheet with SUMPRODUCT, fields read by a person (`eval/SPREADSHEET.md`) | 18 / 18 | 8 / 8 |

Three claims are also worked out row by row in `eval/HANDCALC.md`, by a Python script that imports no HourMatch code. What this shows: the model alone is unreliable at hourly arithmetic, and a spreadsheet is not, once a person has read the claim. HourMatch's value is the shared state the spreadsheet does not have: who holds which hour, what was already retired, under which issuer. What it does not show: anything about real companies (all data is fictional and the loads were designed), or the keyword rules beyond their unit tests. The model was run once, on 14 October 2026, and not re-run.

## Repository

| Path | What |
|---|---|
| `contracts/HourlyCertificateRegistry.sol` | The registry contract |
| `src/ledger.mjs` | Same rules in JavaScript, so the web demo runs without a chain |
| `src/scenario.mjs` | Builds the fictional demo week from the real Taipower curves |
| `src/checker.mjs` | Deterministic claim checker |
| `src/ruleparse.mjs` | Keyword rules for typed sentences |
| `src/upload.mjs` | Your own CSV files to the same ledger and checker |
| `src/parse.mjs`, `src/llm.mjs` | Model parse used by the evaluation (off unless a dedicated key is set) |
| `test/registry.test.cjs` | Contract tests and a replay of the whole demo week on the contract |
| `tests/*.test.mjs` | Checker, keyword rules, upload, hand calculation and spreadsheet checks |
| `eval/` | Claims, results, hand calculation, spreadsheet baseline |
| `scripts/deploy.cjs` | Sepolia deployment of one demo day with separate wallets |
| `scripts/verify_chain.mjs` | Re-reads every Sepolia receipt and `matchedBps` |
| `public/` | The web demo (static) |

## Run it

```bash
npm install
npm test                         # node tests + contract tests (Hardhat)
node scripts/build_web.mjs       # copy engine, data and samples into public/
python -m http.server 5178 -d public
```

Testnet deployment (testnet only). The operator key is read from the environment variable `CLIMATECHAIN_TESTNET_PK`; the five demo wallet keys are generated into `.env.local`, which is git-ignored and never printed:

```bash
npx hardhat run scripts/deploy.cjs --network hardhat   # local dry run
npx hardhat run scripts/deploy.cjs --network sepolia
node scripts/verify_chain.mjs
```

## Data sources

- Taiwan Power Company, real-time generation by unit (data.gov.tw/dataset/8931); history archived at github.com/kiang/taipower_data.
- Implementation Regulations Governing Renewable Energy Certificates (Taiwan, amended 2025-05-26).
- RE100 Technical Criteria, 24 March 2025.
- Bjørn, Lloyd, Brander, Matthews (2022). Renewable energy certificates threaten the integrity of corporate science-based targets. *Nature Climate Change* 12, 539 to 546.
- GHG Protocol, Scope 2 public consultation on hourly matching and deliverability (2025).

## License

MIT
