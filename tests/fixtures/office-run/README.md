# Three moments of a real run

What a OneManCompany office sent at three moments of one real project run, rebuilt with made-up people, ids,
rooms and task texts (the shapes, statuses and room bookings are as the office sent them). Same layout as
`../office`; serve one with `node tests/fake-office.mjs --dir office-run/<moment>`.

| Folder | The office at that moment |
|---|---|
| `1-working` | The EA dispatching the room's goal; Wren (00006) at work on page 1, on the team of the open sprint room `handbook-sprint` with Juniper (00009). `/api/employees` says `working` for both, and `/api/state` lists a `processing` task for each. |
| `2-meeting` | HR's review meeting in Town Hall: the room is booked by HR (00002), who is not in its participant list and whose own status is `idle`; the EA, Wren and Juniper are `in_meeting`. |
| `3-idle` | Everyone idle after the meeting; Town Hall free again; the sprint room still open. |

`budget.json` in each is the office's `/api/budget`: per employee, the tokens its caps count (cache reads included) since midnight.
