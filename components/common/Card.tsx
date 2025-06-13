import React, { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
  titleClassName?: string;
  noPadding?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', title, actions, titleClassName = '', noPadding = false }) => {
  return (
    <div className={`bg-brand-secondary shadow-card rounded-xl overflow-hidden ${className}`}>
      {(title || actions) && (
        <div className={`px-5 py-4 sm:px-6 border-b border-brand-muted/30 flex justify-between items-center ${titleClassName}`}>
          {title && <h3 className={`text-lg leading-6 font-semibold text-brand-primary ${titleClassName}`}>{title}</h3>}
          {actions && <div className="ml-4 flex-shrink-0">{actions}</div>}
        </div>
      )}
      <div className={noPadding ? '' : "px-5 py-5 sm:p-6"}>
        {children}
      </div>
    </div>
  );
};