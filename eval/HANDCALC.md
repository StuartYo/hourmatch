# Hand calculation of three claims

Written by `eval/handcalc.py`, which does not import any HourMatch code. It rebuilds the demo week from the raw
Taipower file with the rules in README.md and works each claim out hour by hour. All companies and plants are
fictional; the generation curves are real Taiwan Power Company data.

Rules used: matched kWh in an hour = min(use, certificates held for that hour). Hour-by-hour share =
sum(matched) / sum(use). Volume share = sum(certificates held) / sum(use). A claim holds if the claimed
percentage is at most the share on its basis plus 0.5 points. Shares are cut to basis points (floor), as the
contract does.

## HC1: Northbay Fab's night shift (00:00 to 06:00) on 2026-10-09 ran on 100% renewable electricity.

Basis: hourly. Company: NORTHBAY-FAB. Hours: 6.

| hour (UTC+8) | use kWh | solar certs kWh | wind certs kWh | certs total | matched = min(use, total) |
|---|---|---|---|---|---|
| 2026-10-09 00:00 | 21891 | 0 | 15709 | 15709 | 15709 |
| 2026-10-09 01:00 | 21891 | 0 | 15311 | 15311 | 15311 |
| 2026-10-09 02:00 | 21891 | 0 | 14726 | 14726 | 14726 |
| 2026-10-09 03:00 | 21891 | 0 | 13958 | 13958 | 13958 |
| 2026-10-09 04:00 | 21891 | 0 | 13405 | 13405 | 13405 |
| 2026-10-09 05:00 | 21891 | 16 | 12758 | 12774 | 12774 |
| **sum** | **131346** | **16** | **85867** | **85883** | **85883** |

- Hour-by-hour share = 85883 / 131346 = 65.3868% -> 6538 basis points
- Volume share = 85883 / 131346 = 65.3868% -> 6538 basis points
- Claimed 100% on the hourly basis: 10000 <= 6538 + 50 is false, so **NOT_SUPPORTED**

## HC2: Harbor Office ran on 100% renewable electricity from 08:00 to 19:00 on 2026-10-07.

Basis: hourly. Company: HARBOR-OFFICE. Hours: 11.

| hour (UTC+8) | use kWh | solar certs kWh | hydro certs kWh | certs total | matched = min(use, total) |
|---|---|---|---|---|---|
| 2026-10-07 08:00 | 5019 | 2185 | 842 | 3027 | 3027 |
| 2026-10-07 09:00 | 5019 | 3265 | 753 | 4018 | 4018 |
| 2026-10-07 10:00 | 5019 | 3916 | 902 | 4818 | 4818 |
| 2026-10-07 11:00 | 5019 | 4246 | 907 | 5153 | 5019 |
| 2026-10-07 12:00 | 5019 | 4120 | 1072 | 5192 | 5019 |
| 2026-10-07 13:00 | 5019 | 3844 | 1133 | 4977 | 4977 |
| 2026-10-07 14:00 | 5019 | 3326 | 1132 | 4458 | 4458 |
| 2026-10-07 15:00 | 5019 | 2352 | 1342 | 3694 | 3694 |
| 2026-10-07 16:00 | 5019 | 1153 | 1588 | 2741 | 2741 |
| 2026-10-07 17:00 | 5019 | 280 | 1433 | 1713 | 1713 |
| 2026-10-07 18:00 | 5019 | 0 | 1736 | 1736 | 1736 |
| **sum** | **55209** | **28687** | **12840** | **41527** | **41220** |

- Hour-by-hour share = 41220 / 55209 = 74.6617% -> 7466 basis points
- Volume share = 41527 / 55209 = 75.2178% -> 7521 basis points
- Claimed 100% on the hourly basis: 10000 <= 7466 + 50 is false, so **NOT_SUPPORTED**

## HC3: Certificates bought by Cloudline Data Center covered 100% of its electricity use on 2026-10-11.

Basis: volume. Company: CLOUDLINE-DC. Hours: 24.

| hour (UTC+8) | use kWh | wind certs kWh | certs total | matched = min(use, total) |
|---|---|---|---|---|
| 2026-10-11 00:00 | 14241 | 15708 | 15708 | 14241 |
| 2026-10-11 01:00 | 14834 | 15022 | 15022 | 14834 |
| 2026-10-11 02:00 | 15428 | 14158 | 14158 | 14158 |
| 2026-10-11 03:00 | 14538 | 14241 | 14241 | 14241 |
| 2026-10-11 04:00 | 15131 | 14453 | 14453 | 14453 |
| 2026-10-11 05:00 | 14241 | 13955 | 13955 | 13955 |
| 2026-10-11 06:00 | 14834 | 14122 | 14122 | 14122 |
| 2026-10-11 07:00 | 15428 | 14533 | 14533 | 14533 |
| 2026-10-11 08:00 | 14538 | 14904 | 14904 | 14538 |
| 2026-10-11 09:00 | 15131 | 15821 | 15821 | 15131 |
| 2026-10-11 10:00 | 14241 | 16739 | 16739 | 14241 |
| 2026-10-11 11:00 | 14834 | 16746 | 16746 | 14834 |
| 2026-10-11 12:00 | 15428 | 15926 | 15926 | 15428 |
| 2026-10-11 13:00 | 14538 | 15589 | 15589 | 14538 |
| 2026-10-11 14:00 | 15131 | 15419 | 15419 | 15131 |
| 2026-10-11 15:00 | 14241 | 15531 | 15531 | 14241 |
| 2026-10-11 16:00 | 14834 | 16481 | 16481 | 14834 |
| 2026-10-11 17:00 | 15428 | 17039 | 17039 | 15428 |
| 2026-10-11 18:00 | 14538 | 16986 | 16986 | 14538 |
| 2026-10-11 19:00 | 15131 | 16598 | 16598 | 15131 |
| 2026-10-11 20:00 | 14241 | 16150 | 16150 | 14241 |
| 2026-10-11 21:00 | 14834 | 15299 | 15299 | 14834 |
| 2026-10-11 22:00 | 15428 | 13540 | 13540 | 13540 |
| 2026-10-11 23:00 | 14538 | 11979 | 11979 | 11979 |
| **sum** | **355729** | **366939** | **366939** | **347144** |

- Hour-by-hour share = 347144 / 355729 = 97.5866% -> 9758 basis points
- Volume share = 366939 / 355729 = 103.1513% -> 10315 basis points
- Claimed 100% on the volume basis: 10000 <= 10315 + 50 is true, so **SUPPORTED**
