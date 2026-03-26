import React from 'react';

// Base props common to both
interface BaseSharedInputProps {
  label?: string;
  error?: string;
  containerClassName?: string;
  leftIcon?: React.ReactNode;
  id?: string;
  className?: string;
}

// Props when the component is a standard input element
interface StandardInputProps extends BaseSharedInputProps, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'className' | 'type'> {
  type?: Exclude<React.HTMLInputTypeAttribute, 'textarea'>;
}

// Props when the component is a textarea element
interface TextareaInputProps extends BaseSharedInputProps, Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'id' | 'className'> {
  type: 'textarea';
}

export type InputProps = StandardInputProps | TextareaInputProps;

export const Input: React.FC<InputProps> = ({ label, id, error, containerClassName = '', className = '', leftIcon, ...props }) => {
  const commonInputVisualClass = `w-full px-3 py-2.5 bg-brand-secondaryLight dark:bg-brand-dark-surfaceHighlight border border-brand-muted dark:border-brand-dark-border rounded-lg text-brand-text dark:text-brand-dark-text placeholder-brand-muted dark:placeholder-brand-dark-textSecondary focus:ring-brand-primary focus:border-brand-primary sm:text-sm shadow-sm transition-colors duration-200 ${error ? 'border-status-error focus:ring-status-error' : ''}`;

  if (props.type === 'textarea') {
    // Type is known to be 'textarea' here, so we cast props to TextareaInputProps
    // and destructure specific props, excluding 'type' as it's already handled.
    const { type: _type, ...textareaSpecificProps } = props as Omit<TextareaInputProps, keyof BaseSharedInputProps>;
    return (
      <div className={`mb-4 ${containerClassName}`}>
        {label && <label htmlFor={id} className="block text-sm font-medium text-brand-lightText mb-1.5">{label}</label>}
        <textarea
          id={id}
          className={`${commonInputVisualClass} ${className}`} // className from props is applied here. leftIcon styling is not applied.
          {...textareaSpecificProps}
        />
        {error && <p className="mt-1.5 text-xs text-status-error">{error}</p>}
      </div>
    );
  }

  // Standard input element
  // Here, props is of type StandardInputProps. We access props.type directly.
  const { ...inputSpecificProps } = props as Omit<StandardInputProps, keyof BaseSharedInputProps | 'type'>;
  return (
    <div className={`mb-4 ${containerClassName}`}>
      {label && <label htmlFor={id} className="block text-sm font-medium text-brand-lightText mb-1.5">{label}</label>}
      <div className="relative">
        {leftIcon && <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-brand-muted">{leftIcon}</div>}
        <input
          id={id}
          type={props.type} // Access props.type directly
          className={`${commonInputVisualClass} ${leftIcon ? 'pl-10' : ''} ${className}`}
          {...inputSpecificProps}
        />
      </div>
      {error && <p className="mt-1.5 text-xs text-status-error">{error}</p>}
    </div>
  );
};