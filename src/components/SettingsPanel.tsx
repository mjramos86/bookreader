import { FONTS } from '../lib/fonts';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, THEMES, type Settings } from '../lib/settings';

interface Props {
  settings: Settings;
  update: (p: Partial<Settings>) => void;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPanel({ settings, update }: Props) {
  const s = settings;
  const bump = (d: number) => update({ fontSize: Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, s.fontSize + d)) });
  return (
    <div className="settings" role="dialog" aria-label="Display settings">
      <div className="set-row">
        <div className="themes" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.name}
              role="radio"
              aria-checked={s.theme === t.name}
              className={`theme-dot ${s.theme === t.name ? 'on' : ''}`}
              style={{ background: t.bg, color: t.fg }}
              onClick={() => update({ theme: t.name })}
              title={t.label}
            >
              <span>Aa</span>
              <span className="sr-only">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-row size-row">
        <button className="step small" onClick={() => bump(-1)} aria-label="Smaller text" disabled={s.fontSize <= FONT_SIZE_MIN}>A</button>
        <input
          type="range"
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          value={s.fontSize}
          onChange={(e) => update({ fontSize: Number(e.target.value) })}
          aria-label="Text size"
        />
        <button className="step big" onClick={() => bump(1)} aria-label="Larger text" disabled={s.fontSize >= FONT_SIZE_MAX}>A</button>
      </div>

      <div className="set-row">
        <label className="set-label" htmlFor="font-select">Font</label>
        <div className="font-list" id="font-select" role="radiogroup" aria-label="Font">
          {FONTS.map((f) => (
            <button
              key={f.id}
              role="radio"
              aria-checked={s.fontFamily === f.id}
              className={s.fontFamily === f.id ? 'on' : ''}
              style={{ fontFamily: f.stack }}
              onClick={() => update({ fontFamily: f.id })}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="set-row">
        <span className="set-label">Line spacing</span>
        <Segmented
          label="Line spacing"
          value={s.lineHeight}
          onChange={(v) => update({ lineHeight: v })}
          options={[
            { value: 1.3, label: 'Tight' },
            { value: 1.55, label: 'Normal' },
            { value: 1.85, label: 'Relaxed' },
            { value: 2.15, label: 'Loose' },
          ]}
        />
      </div>

      <div className="set-row">
        <span className="set-label">Margins</span>
        <Segmented
          label="Margins"
          value={s.margin}
          onChange={(v) => update({ margin: v })}
          options={[
            { value: 'narrow', label: 'Narrow' },
            { value: 'medium', label: 'Medium' },
            { value: 'wide', label: 'Wide' },
          ]}
        />
      </div>

      <div className="set-row">
        <span className="set-label">Alignment</span>
        <Segmented
          label="Alignment"
          value={s.align}
          onChange={(v) => update({ align: v })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'justify', label: 'Justified' },
          ]}
        />
      </div>

      <div className="set-row">
        <span className="set-label">Layout</span>
        <Segmented
          label="Layout"
          value={s.layout}
          onChange={(v) => update({ layout: v })}
          options={[
            { value: 'paged', label: 'Pages' },
            { value: 'scroll', label: 'Continuous scroll' },
          ]}
        />
      </div>

      {s.layout === 'paged' && (
        <div className="set-row">
          <span className="set-label">Columns</span>
          <Segmented<string>
            label="Columns"
            value={String(s.columns)}
            onChange={(v) => update({ columns: v === 'auto' ? 'auto' : (Number(v) as 1 | 2) })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: '1', label: 'One' },
              { value: '2', label: 'Two' },
            ]}
          />
        </div>
      )}

      <div className="set-row toggle-row">
        <label>
          <input type="checkbox" checked={s.hyphenate} onChange={(e) => update({ hyphenate: e.target.checked })} /> Hyphenate words
        </label>
        <label>
          <input type="checkbox" checked={s.publisherFonts} onChange={(e) => update({ publisherFonts: e.target.checked })} /> Use the book’s own fonts
        </label>
      </div>

      <div className="set-row bright-row">
        <span className="set-label">Brightness</span>
        <input type="range" min={40} max={100} value={s.brightness} onChange={(e) => update({ brightness: Number(e.target.value) })} aria-label="Brightness" />
      </div>
    </div>
  );
}
