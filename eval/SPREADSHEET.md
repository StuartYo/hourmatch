# Spreadsheet baseline

What a careful analyst gets with an ordinary spreadsheet, given the same hourly data and the claim fields read by a person.
All companies and plants are fictional; the generation curves are real Taiwan Power Company data.

Files:

- `spreadsheet/data_dev.csv`, `spreadsheet/data_holdout.csv`: one row per company per hour (504 rows per week).
- `spreadsheet/claims_dev.csv`, `spreadsheet/claims_holdout.csv`: the claim fields (company, days, hours, weekdays only, claimed %, basis, RE100) and the true verdict.
- `spreadsheet_baseline.xlsx`: both of the above with live formulas. Excel recalculated it on 2026-10-15 and every value matched `results_spreadsheet.json` (`results_spreadsheet_excel.json`).
- `spreadsheet_baseline.mjs` writes the CSV files and computes the same formulas in JavaScript; `make_xlsx.py` builds the workbook.

## Data sheet columns

A company, B date, C day number (1 to 7), D hour (0 to 23, UTC+8), E weekday (1 = Monday ... 7 = Sunday), F use kWh,
G to I certificates held for that hour per plant, J certificates total, K certificates from plants commissioned before 2011.

```
L  matched      =MIN(F2,J2)
M  old_matched  =MIN(K2,MAX(0,F2-(J2-K2)))      older plants are used last
```

## Claim sheet formulas (row 2, data in rows 2 to 505)

Row filter, written once here as MASK:

```
MASK = (data!$A$2:$A$505=$C2)*(data!$C$2:$C$505>=$D2)*(data!$C$2:$C$505<=$E2)
      *(data!$D$2:$D$505>=$F2)*(data!$D$2:$D$505<$G2)*((($H2=0)+(data!$E$2:$E$505<=5))>0)
```

```
use          =SUMPRODUCT(MASK*data!$F$2:$F$505)
matched      =SUMPRODUCT(MASK*data!$L$2:$L$505)
certs        =SUMPRODUCT(MASK*data!$J$2:$J$505)
hourly_bps   =INT(matched*10000/use)
volume_bps   =INT(certs*10000/use)
share_bps    =IF(RE100, the same with old-plant kWh above 15% of use removed, IF(basis="volume", volume_bps, hourly_bps))
verdict      =IF(AND(ROUND(claimed*100,0)<=plain_bps+50, ROUND(claimed*100,0)<=share_bps+50), "SUPPORTED", "NOT_SUPPORTED")
```

## Result

Dev 18 / 18, holdout 8 / 8: the spreadsheet agrees with HourMatch on every claim.

This is the point of the baseline. The arithmetic is easy once a person has turned the sentence into fields. A spreadsheet
does not know whether the certificates in column G to I were also counted in another company's sheet, whether a plant sold the
same hour twice, or whether the numbers were edited after the claim was published. Those are the parts the shared contract
enforces, and they are tested by `test/registry.test.cjs`, not by this evaluation.
