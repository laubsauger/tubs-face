import type { JSX, ReactNode } from 'react';

export function ControlGroup(props: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-2 pt-3 border-t border-slate-800/70">
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{props.title}</h3>
      {props.children}
    </section>
  );
}

function Row(props: { label: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <label className="grid grid-cols-[minmax(84px,1fr)_minmax(0,1.3fr)] items-center gap-2 text-xs font-mono">
      <span className="text-slate-400 truncate">{props.label}</span>
      <span className="flex justify-end min-w-0">{props.children}</span>
    </label>
  );
}

export function ToggleControl(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <Row label={props.label}>
      <input
        type="checkbox"
        role="switch"
        className="control-switch"
        checked={props.checked}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
    </Row>
  );
}

export function SelectControl<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<T | { value: T; label: string }>;
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <Row label={props.label}>
      <select
        className="mini-select w-full"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value as T)}
      >
        {props.options.map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const label = typeof option === 'string' ? option : option.label;
          return <option key={value} value={value}>{label}</option>;
        })}
      </select>
    </Row>
  );
}

export function RangeControl(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}): JSX.Element {
  const shown = props.format ? props.format(props.value) : String(props.value);
  return (
    <Row label={<>{props.label} <span className="text-cyan-400">{shown}</span></>}>
      <input
        type="range"
        className="w-full accent-cyan-500"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
    </Row>
  );
}

export function ColorControl(props: { label: string; value: string; onChange: (value: `#${string}`) => void }): JSX.Element {
  return (
    <Row label={props.label}>
      <input
        type="color"
        className="fx-color-input"
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value as `#${string}`)}
      />
    </Row>
  );
}

export function ButtonControl(props: { label: string; text: string; onClick: () => void }): JSX.Element {
  return (
    <Row label={props.label}>
      <button type="button" className="button button-secondary button-compact" onClick={props.onClick}>{props.text}</button>
    </Row>
  );
}
