import { useState } from 'react';
import { fmtMoney } from '../format';

// Whole-dollar money for headline figures; cents only where they matter (a
// per-film price). fmtMoney already rounds to whole dollars with a $ and commas.
const money2 = (n) =>
  n == null ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A tappable figure that reveals a plain-English explanation beneath it.
function Explain({ open, onToggle, className = '', children, note }) {
  return (
    <div className={`alv-x ${className} ${open ? 'open' : ''}`} onClick={onToggle}>
      {children}
      <div className="alv-explain">{note}</div>
    </div>
  );
}

export default function AListValueModal({ value, periodLabel, onClose }) {
  const [open, setOpen] = useState(null); // key of the currently expanded figure
  const toggle = (k) => setOpen((cur) => (cur === k ? null : k));

  const v = value || {};
  const tickets = v.tickets || 0;
  const fee = v.fee || 0;
  const ticketValue = v.ticket_value || 0;
  const savings = v.savings;
  const ahead = (savings || 0) >= 0;

  const avgTicket = tickets > 0 ? ticketValue / tickets : null;
  const costPerFilm = tickets > 0 ? fee / tickets : null;
  const valuePerDollar = fee > 0 ? ticketValue / fee : null;
  const breakEven = avgTicket ? fee / avgTicket : null;

  // All-time view earns the per-year list; a single year is already that year.
  const years = (v.by_year || []).filter((y) => y.films > 0);
  const showYears = years.length > 1;

  const excluded = savings == null;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet alv-sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="sheet-close" onClick={onClose} aria-label="Close">
          ✕
        </button>

        <div className="alv-pad">
          <div className="alv-eyebrow">A-List Value</div>
          <div className="alv-period">{periodLabel}</div>
          <div className="alv-hint">tap any figure for what it means</div>

          {excluded ? (
            <div className="alv-excluded">
              You weren’t an A-Lister for this period, so its films don’t count toward savings.
              Toggle membership under “Edit A-List membership”.
            </div>
          ) : (
            <>
              <Explain
                className="alv-hero"
                open={open === 'net'}
                onToggle={() => toggle('net')}
                note="What your tickets were worth minus what you paid A-List. Positive means the membership has more than paid for itself."
              >
                <div className={`alv-hero-num ${ahead ? 'up' : 'down'}`}>
                  {ahead ? fmtMoney(savings) : `-${fmtMoney(Math.abs(savings))}`}
                </div>
                <div className="alv-hero-sub">
                  {ahead ? 'ahead of your A-List fee' : 'behind your A-List fee'}
                </div>
              </Explain>

              <div className="alv-receipt">
                <Explain
                  open={open === 'paid'}
                  onToggle={() => toggle('paid')}
                  note="Your monthly A-List fee times the months you actually saw a film. Idle months aren’t billed, so they never count against you."
                >
                  <div className="alv-row">
                    <div className="alv-row-label">
                      Paid to A-List
                      <span className="alv-row-sub">
                        {v.months} {v.months === 1 ? 'month' : 'months'} × {money2(v.monthly_fee)}
                      </span>
                    </div>
                    <div className="alv-row-val">{fmtMoney(fee)}</div>
                  </div>
                </Explain>

                <Explain
                  open={open === 'value'}
                  onToggle={() => toggle('value')}
                  note="What these films would have cost out of pocket — a standard ticket each, plus a little more for premium formats like IMAX or Dolby."
                >
                  <div className="alv-row">
                    <div className="alv-row-label">
                      Tickets would’ve cost
                      <span className="alv-row-sub">
                        {tickets} {tickets === 1 ? 'film' : 'films'} at the box office
                      </span>
                    </div>
                    <div className="alv-row-val">{fmtMoney(ticketValue)}</div>
                  </div>
                </Explain>

                <Explain
                  className="alv-total"
                  open={open === 'net2'}
                  onToggle={() => toggle('net2')}
                  note="Ticket value minus what you paid A-List — your real savings over buying every ticket yourself."
                >
                  <div className="alv-row">
                    <div className="alv-row-label">Net saved</div>
                    <div className="alv-row-val">
                      {ahead ? `+${fmtMoney(savings)}` : `-${fmtMoney(Math.abs(savings))}`}
                    </div>
                  </div>
                </Explain>
              </div>

              <div className="alv-tiles">
                <Explain
                  className="alv-tile"
                  open={open === 'cpf'}
                  onToggle={() => toggle('cpf')}
                  note="What you paid A-List divided by films seen — your effective price per movie."
                >
                  <div className="alv-tile-num accent">{costPerFilm == null ? '—' : money2(costPerFilm)}</div>
                  <div className="alv-tile-cap">cost per film</div>
                </Explain>

                <Explain
                  className="alv-tile"
                  open={open === 'vpd'}
                  onToggle={() => toggle('vpd')}
                  note="Ticket value ÷ what you paid. 2× means every A-List dollar bought $2 of movies."
                >
                  <div className="alv-tile-num accent">
                    {valuePerDollar == null ? '—' : `${valuePerDollar.toFixed(1)}×`}
                  </div>
                  <div className="alv-tile-cap">value per dollar</div>
                </Explain>

                <Explain
                  className="alv-tile"
                  open={open === 'films'}
                  onToggle={() => toggle('films')}
                  note="Films credited toward savings; “premium” are IMAX / Dolby / 3D shows that would’ve cost extra."
                >
                  <div className="alv-tile-num">{tickets}</div>
                  <div className="alv-tile-cap">
                    films{v.premium_tickets ? ` · ${v.premium_tickets} premium` : ''}
                  </div>
                </Explain>

                <Explain
                  className="alv-tile"
                  open={open === 'be'}
                  onToggle={() => toggle('be')}
                  note="At your fee and average ticket price, about this many films a month covers the cost — anything beyond is savings."
                >
                  <div className="alv-tile-num">{breakEven == null ? '—' : breakEven.toFixed(1)}</div>
                  <div className="alv-tile-cap">films/mo to break even</div>
                </Explain>
              </div>

              {showYears && (
                <>
                  <div className="alv-section-eyebrow">By year</div>
                  {years.map((y) => (
                    <Explain
                      key={y.year}
                      className={`alv-yr ${y.is_member ? '' : 'out'}`}
                      open={open === `y${y.year}`}
                      onToggle={() => toggle(`y${y.year}`)}
                      note={
                        y.is_member
                          ? `Net saved in ${y.year} — tickets worth ${fmtMoney(y.ticket_value)} against ${y.months} ${
                              y.months === 1 ? 'month' : 'months'
                            } of fees.`
                          : `You weren’t a member in ${y.year}, so its films don’t count toward savings.`
                      }
                    >
                      <div className="alv-yr-row">
                        <div>
                          <div className="alv-yr-name">{y.year}</div>
                          <div className="alv-yr-meta">
                            {y.is_member
                              ? `${y.films} ${y.films === 1 ? 'film' : 'films'} · ${y.months} ${
                                  y.months === 1 ? 'month' : 'months'
                                }`
                              : 'not an A-Lister'}
                          </div>
                        </div>
                        <div className="alv-yr-val">
                          {y.savings == null ? '—' : `+${fmtMoney(y.savings)}`}
                        </div>
                      </div>
                    </Explain>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
