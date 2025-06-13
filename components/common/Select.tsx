import React from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  containerClassName?: string;
  options: { value: string | number; label: string }[];
}

export const Select: React.FC<SelectProps> = ({ label, id, error, containerClassName = '', className = '', options, ...props }) => {
  return (
    <div className={`mb-4 ${containerClassName}`}>
      {label && <label htmlFor={id} className="block text-sm font-medium text-brand-lightText mb-1.5">{label}</label>}
      <select
        id={id}
        className={`w-full px-3 py-2.5 bg-brand-secondaryLight border border-brand-muted rounded-lg text-brand-text focus:ring-brand-primary focus:border-brand-primary sm:text-sm shadow-sm appearance-none ${error ? 'border-status-error focus:ring-status-error' : ''} ${className}`}
        {...props}
      >
        {options.map(option => (
          <option key={option.value} value={option.value} className="bg-brand-secondary text-brand-text">
            {option.label}
          </option>
        ))}
      </select>
      {error && <p className="mt-1.5 text-xs text-status-error">{error}</p>}
    </div>
  );
};