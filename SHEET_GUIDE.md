# Your Google Sheet, tab by tab

The Google Sheet is the app's database. Each tab is one table, and **row 1 holds the column names**.

## Three golden rules
1. **Never rename a tab or change row 1.** The app finds data by those names.
2. **Never use "Convert to table", dropdown chips or data-validation rules** on these tabs. The app writes values like *Issued*, *Damaged*, *Missing* and *Scrapped*, and a dropdown that doesn't list them blocks the write.
3. **Only type into the tabs marked "You fill".** Every other tab is filled by the app. Look at those, but don't edit them.

---

## Tabs you fill

### HeaterModels: one row per heater *type*
| Column | What to put | Example |
|---|---|---|
| ModelID | A short code you choose. Use it again in ComponentTypes and Components. | `HM-01` |
| ModelName | The name people will see | `Almex 1200 mm` |
| Make | Manufacturer | `Almex` |
| BeltWidthMin_mm / BeltWidthMax_mm | The belt width range this heater suits | `1000` / `1400` |
| RatingMax_Nmm | The highest belt rating it can do | `1600` |
| PliesMax | The most plies it can do (leave empty if it doesn't matter) | `5` |
| Power_kW, Voltage_V, Notes | Optional | |

The width and rating columns decide which heaters **Find a heater** suggests.

### ComponentTypes: what one *complete set* of each model contains
| Column | What to put | Example |
|---|---|---|
| ModelID | Same code as in HeaterModels | `HM-01` |
| ComponentName | The part name. Type it exactly the same way every time. | `Pressure bag` |
| QtyPerSet | How many of this part one set needs | `2` |
| IsSerialised | `Y` if each piece has its own number/sticker, `N` for loose items like bolts | `Y` |
| UnitCost | Optional | |

### Components: every *physical* part in your store
| Column | What to put | Example |
|---|---|---|
| ComponentID | The sticker/QR number on the part. Must be unique. | `HM-01-S1-PB` |
| ModelID | Which heater model it belongs to | `HM-01` |
| SetNo | Which set it is normally kept with | `1` |
| ComponentName | Exactly as written in ComponentTypes | `Pressure bag` |
| SerialNo | Maker's serial number (optional) | |
| Qty | `1` for numbered parts; the count for a lot of loose items | `1` |
| Condition | `OK`, `Damaged`, `Under repair` or `Scrapped` | `OK` |
| Status | `In store` when you first enter it | `In store` |
| MaintenanceStatus | `OK`, or `Due` if it needs maintenance before use | `OK` |
| JointsSinceMaintenance | `0` to start | `0` |
| CurrentTicket, CurrentConveyor, LastInspected | **Leave empty.** The app fills these. | |
| Remarks | Optional note | |

### HeaterSelection: your heater selection guide
One row per belt width and rating, saying which heaters may be used. **When this tab has rows, it alone decides which heaters "Find a heater" suggests** (the width/rating columns in HeaterModels are then only for information).
| Column | What to put | Example |
|---|---|---|
| BeltWidth_mm | Belt width | `1200` |
| BeltRating | Rating in N/mm, or `ST1000` style for steel cord | `1000` |
| Plies | Number of plies (empty for steel cord) | `4` |
| HeaterIDs | The heater numbers allowed, separated by commas, written exactly as the ModelID | `12-EF, 12-GH, 12-IJ` |
| Notes | Optional | |

### Conveyors: your conveyor list
ConveyorName, Area, BeltWidth_mm, BeltRating_Nmm, Plies, Notes. The belt details let the app auto-fill the heater search.

### Departments
One column, **Department**. Keep only the departments that take material, for you **FM** and **RTG**.

### Consumables: the 14 materials
| Column | What to put |
|---|---|
| ItemID | Already filled (`C01`…`C14`). **Don't change it.** |
| ItemName | Already filled. You may correct the spelling. |
| Manufacturer, Unit (kit / kg / litre / roll), ReorderLevel, SAPStock | Fill these, or use **Edit details** in the app |
| SAPStockUpdatedOn | Leave empty (the app fills it) |

### ConsumableBatches: current stock
It's easier to add stock in the app (**Consumables → Update stock → Received into store**). If you type it here instead, use one row per batch: ItemID, BatchNo, Qty, ExpiryDate (`2027-03-31`), ReceivedOn.

### Users
**Use the Users page in the app instead.** It sets passwords safely. Never type into PasswordHash or Salt.
- **Role:** Admin / Local / HOD / RTG Chief / FM Chief
- **Team:** RTG / FM / Vendor. The maintenance vendor must be **Vendor** to see the Maintenance page.

### Settings
Fill only the **Value** column:
- **CompanyInbox:** your company mail address
- **RTGTeamMail:** RTG team mail address(es), separated by commas
- **OverdueTo**, **OverdueCC**, **RejectCC:** mail lists
- **OverdueMailHour**, **ExportTime:** hours, 0 to 23
- **AppUrl:** the website address

Don't delete Settings rows. **ChecklistFolderId** is filled automatically.

---

## Tabs the app fills (look, don't edit)
| Tab | What it holds |
|---|---|
| Requests | Every heater request (RTGH0001…) |
| Tickets | One row per approved request (HEATER_0001…), with its status and return date |
| TicketItems | Each component issued on each ticket, and how it came back |
| Issues | Damaged or missing parts (ISS0001…), with FM's explanation and action |
| TransferRequests, Approvals | Site transfers (RTGT0001…) and each approver's decision |
| MaintenanceLogs | The vendor's maintenance logs (MNT0001…) and RTG's check |
| ConsumableTransactions | Every stock receipt, issue and correction |
| ConsumableRequests | Material requests (RTGC0001…) and tickets (CONS_0001…) |
| Counters | The last number used for each kind of request. **Never edit it**, or numbers will repeat. |
| MailOutbox | Every mail the app sent |
| AuditLog | Who did what, and when |

---

## Can I delete rows?
- **SAMPLE rows** in HeaterModels, ComponentTypes, Components and Conveyors: **yes.** Delete them once your real data is in, by right-clicking the row number and choosing *Delete row*.
- **Test requests, tickets and so on:** don't delete them one by one, because the tabs are linked to each other. When you've finished testing and want to go live, use the one-click clean-up instead:
  1. Open **Extensions → Apps Script**.
  2. Pick **clearTestData** from the function list at the top and press **Run**.

  It removes all test activity and starts the numbers again at 0001. It keeps your users, settings, heaters, parts, conveyors and materials, and puts every part back "In store".
- **Never delete** row 1, your own admin user, Settings rows, or Counters rows while the app is in use.
