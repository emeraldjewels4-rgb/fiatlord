# Fiat issuance rules, sourced, and what LVR actually copies

The brief asked for the fiat rules "positioned by world wide web internet truth". This file
does that: each rule is stated with the source that says it, then the row underneath says
what this repository does — including the two places where it does the **opposite** of fiat
practice, because a document that only lists the similarities is marketing.

Sources are central-bank and inter-governmental publications, not commentary:

- **BoE 2014** — McLeay, Radia & Thomas, *Money creation in the modern economy*, Bank of
  England Quarterly Bulletin 2014 Q1.
  <https://www.bankofengland.co.uk/quarterly-bulletin/2014/q1/money-creation-in-the-modern-economy>
- **Fed H.6** — Board of Governors, *Money Stock Measures*.
  <https://www.federalreserve.gov/releases/h6/current/default.htm>
- **FATF Rec. 11** — *The FATF Recommendations*, Recommendation 11 (Record-keeping).
  <https://www.fatf-gafi.org/content/dam/fatf-gafi/recommendations/fatf-recommendations-2012.pdf>
- **UK MLR 2017 reg. 40** — *Money Laundering, Terrorist Financing and Transfer of Funds
  (Information on the Payer) Regulations 2017*, regulation 40 (record-keeping period).
  <https://www.legislation.gov.uk/uksi/2017/692/regulation/40>

---

## Rule 1 — Most money is created by lending, so supply is elastic

> "This article explains how the majority of money in the modern economy is created by
> commercial banks making loans. … nor do they 'multiply up' central bank money to create
> new loans and deposits."
> — BoE 2014, summary

Money is created when a bank writes a loan and a matching deposit at the same instant. There
is no pile of backing that must be gathered first, and no fixed quantity being allocated.

**LVR:** elastic by construction. `mint(to, amount)` is uncapped and the owner can call it at
will. The *quantity* is elastic, which is the copied part. The *mechanism* is not: fiat money
enters through credit that must be repaid, LVR enters as a grant to five admin wallets with
no borrower, no collateral and no repayment. Elastic supply without a credit channel is
issuance, not banking.

## Rule 2 — Policy sets the pace, not a ceiling

> "In normal times, the central bank does not fix the amount of money in circulation"
> — BoE 2014

No major fiat currency has a hard supply cap. The constraint is a policy process — a rate,
asset purchases, a target — reviewed on a calendar, and the quantity follows demand.

**LVR:** copied in shape. There is no `MAX_SUPPLY`. Two four-week mint windows per year
(before Christmas, GMT+11), a recorded full mark, and a rule that only a person with
`--target` can move that mark. The pace is on a calendar; the ceiling does not exist.

**Where it differs:** a central bank changes policy at scheduled meetings with published
minutes and a committee behind the decision. Here there is one key, and the calendar is
enforced by `topup.mjs --within-window`, not by the contract; the one rule the contract does
enforce by itself is the restore of a zeroed wallet, and that rule has no calendar. The owner can call `mint()`
directly, at any moment, for any amount, and nothing in `Loveriver.sol` stops it. The
schedule is a commitment by the operator, not a constraint on the token.

## Rule 3 — The authority can create money directly when the system stops

> "The central bank can also affect the amount of money directly through purchasing assets
> or 'quantitative easing'."
> — BoE 2014, summary

When the ordinary channel fails, the issuer steps in and creates the money itself rather than
waiting for the market to supply it.

**LVR:** this is the floor refill. Any admin wallet below half of the mark is minted straight
back to the **full mark**, **ungated** — no window, no calendar, no approval. The rule is that
a drained wallet is not left drained, and that it comes back at full strength rather than at
half. Only the band between half and the mark is the gated issuance that waits for a window.

**Where it differs:** the floor is mechanical and unconditional. Real liquidity support is
discretionary, priced, collateralised and sterilised, and it is a loan against assets rather
than a gift. LVR's floor creates tokens permanently and takes nothing in return. Calling that
"quantitative easing" would overstate it; it is a top-up.

## Rule 4 — The quantity is measured and published

> "M2 consists of M1 plus (1) small-denomination time deposits … and (2) balances in retail
> money market funds (MMFs) …" — Fed H.6

Fiat is not merely elastic, it is *counted*: weekly H.6 releases in the US, monthly aggregates
elsewhere, so anyone can see how much exists and how fast it grew.

**LVR:** the measurement is on chain and public — `totalSupply()`, plus a `Transfer` event
from the zero address on every mint, so expansion is visible to anyone with the address. The
clock prints the projected annual expansion. This is the strongest part of the analogy: no
trust in an operator's spreadsheet is required to count the supply.

## Rule 5 — Transaction records are kept, by law, for years

> "Financial institutions should be required to maintain, for at least five years, all
> necessary records on transactions … sufficient to permit reconstruction of individual
> transactions" — FATF Recommendation 11

> "the period is five years … A relevant person is not required to keep the records … for
> more than 10 years." — UK MLR 2017, reg. 40

This is the rule the brief inverts. Regulated fiat payment records — deposits, withdrawals,
card transactions, transfers — are **retained for a minimum of five years** precisely so that
individual transactions can be reconstructed. Cash is private at the point of sale; the
account side is not private at all.

**LVR:** the mint ledger keeps ten minutes and then destroys itself
(`tools/mint-ledger.mjs`). That is a deliberate privacy choice, and it is the opposite of the
fiat record-keeping rule. Two consequences follow, and neither is optional:

1. **The local record cannot serve as an audit trail.** After ten minutes there is no window,
   admin, amount, hash or timestamp left to inspect — by design.
2. **The chain still can.** Every one of those mints is an owner-signed transaction in a
   public block. Deleting the local line deletes a convenience copy, never the transaction.
   A 10-minute retention buys no on-chain privacy whatsoever.

So the retention rule is defensible as "this machine does not accumulate a payment table", and
indefensible as "these mints are untraceable". The whitepaper states both.

---

## Summary table

| Fiat rule | LVR | Verdict |
|---|---|---|
| Money is created by lending (BoE) | Uncapped owner mint with no borrower | Supply elasticity copied; credit channel absent |
| No fixed supply, policy sets the pace (BoE) | No cap; two windows a year; recorded mark | Copied in shape, unenforced on chain |
| Direct creation as a backstop (BoE/QE) | Ungated refill of anything below half to the full mark | Copied mechanically; unconditional where fiat is discretionary |
| Quantity is measured and published (H.6) | `totalSupply()` + mint `Transfer` events | Copied |
| Records kept ≥ 5 years (FATF 11) | Ledger deleted after 10 minutes | **Opposite** |
| Legal tender, central-bank independence, deposit insurance | None of these | Absent |

## What "fiat rules" can honestly mean here

It means **supply discipline**: elastic, paced by a calendar rather than a cap, backstopped so
the pool never sits empty, and measurable by anyone. It does not mean the institutional side
of fiat — no legal tender status, no independent committee, no deposit protection, no
supervisor — and it does not mean fiat's record-keeping. A token with a single owner key that
can mint without limit is not a central bank; it is a token whose operator has published the
rules they intend to follow.
