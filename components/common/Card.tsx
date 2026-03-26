import React, { ReactNode, useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

interface CardProps {
  children: ReactNode;
  className?: string;
  title?: string;
  actions?: ReactNode;
  titleClassName?: string;
  noPadding?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', title, actions, titleClassName = '', noPadding = false }) => {
  const cardRef = useRef<HTMLDivElement>(null);

  useGSAP(() => {
    const card = cardRef.current;
    if (!card) return;

    // Subtle scale and lift on hover
    card.addEventListener('mouseenter', () => {
      gsap.to(card, { y: -5, scale: 1.02, duration: 0.3, ease: 'power2.out', boxShadow: '0 10px 30px -5px rgba(79, 70, 229, 0.2)' });
    });

    card.addEventListener('mouseleave', () => {
      gsap.to(card, { y: 0, scale: 1, duration: 0.3, ease: 'power2.out', boxShadow: 'none' });
    });

  }, { scope: cardRef });

  return (
    <div ref={cardRef} className={`glass-card rounded-2xl overflow-hidden transition-all duration-300 ${className}`}>
      {(title || actions) && (
        <div className={`px-5 py-4 sm:px-6 border-b border-brand-muted/30 dark:border-brand-dark-border flex justify-between items-center ${titleClassName}`}>
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