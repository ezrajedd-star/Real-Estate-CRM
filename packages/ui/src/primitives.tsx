'use client';

import { clsx } from 'clsx';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  forwardRef,
  useEffect,
  useId,
  useRef,
} from 'react';

export const cx = clsx;

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }
>(function Button({ variant = 'primary', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
        variant === 'secondary' &&
          'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
      {...props}
    />
  );
});

const fieldClass =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 aria-[invalid=true]:border-red-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cx(fieldClass, className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx(fieldClass, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cx(fieldClass, className)} {...props}>
        {children}
      </select>
    );
  },
);

/** Label + control + error, wired for screen readers. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({
  tone = 'slate',
  children,
}: {
  tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue';
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'slate' && 'bg-slate-100 text-slate-700',
        tone === 'green' && 'bg-green-100 text-green-800',
        tone === 'amber' && 'bg-amber-100 text-amber-800',
        tone === 'red' && 'bg-red-100 text-red-800',
        tone === 'blue' && 'bg-brand-100 text-brand-700',
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Alert({
  tone = 'red',
  children,
}: {
  tone?: 'red' | 'amber' | 'green' | 'blue';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'red' ? 'alert' : 'status'}
      className={cx(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'red' && 'border-red-200 bg-red-50 text-red-800',
        tone === 'amber' && 'border-amber-200 bg-amber-50 text-amber-800',
        tone === 'green' && 'border-green-200 bg-green-50 text-green-800',
        tone === 'blue' && 'border-brand-100 bg-brand-50 text-brand-900',
      )}
    >
      {children}
    </div>
  );
}

/** Accessible modal built on the native <dialog> element. */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className="w-full max-w-lg rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="border-b border-slate-200 px-5 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </dialog>
  );
}

export function Table({
  head,
  children,
  empty,
}: {
  head: ReactNode[];
  children: ReactNode;
  empty?: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50">
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                scope="col"
                className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
      {empty && <p className="px-3 py-6 text-center text-sm text-slate-500">{empty}</p>}
    </div>
  );
}

export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <td className={cx('whitespace-nowrap px-3 py-2 text-slate-800', className)}>{children}</td>
  );
}
