
import React, { ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button'; 

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  footerContent?: ReactNode;
  hideCloseButton?: boolean;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = 'md', footerContent, hideCloseButton = false }) => {
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setShowModal(true);
    } else {
      // Delay unmounting for animation
      const timer = setTimeout(() => setShowModal(false), 300); // Match animation duration
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!showModal && !isOpen) return null; // Fully hidden and unmounted
  if (typeof document === 'undefined') return null;

  const sizeClasses = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-md',
    lg: 'sm:max-w-lg',
    xl: 'sm:max-w-xl',
    '2xl': 'sm:max-w-2xl',
    'full': 'sm:max-w-5xl',
  };

  const isFull = size === 'full';

  const modalContent = (
    <div 
      className={`fixed inset-0 z-[100] flex ${isFull ? 'items-center p-0 m-0' : 'items-end p-0 sm:items-center sm:p-4'} justify-center transition-opacity duration-300 ease-out
                  ${isOpen ? 'opacity-100 bg-brand-bg/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`}
      aria-labelledby="modal-title" 
      role="dialog" 
      aria-modal="true"
    >
      <div 
        className={`bg-brand-secondary ${isFull ? 'rounded-none h-[100dvh] w-full sm:h-auto sm:rounded-xl' : 'rounded-t-2xl sm:rounded-xl my-0 sm:my-8 w-full'} text-left overflow-hidden shadow-modal transform transition-all duration-300 ease-out sm:align-middle ${sizeClasses[size]} flex flex-col
                    ${isOpen ? 'opacity-100 translate-y-0 sm:scale-100' : `opacity-0 ${isFull ? 'translate-y-4' : 'translate-y-8'} sm:translate-y-0 sm:scale-95`}`}
      >
        <div 
          className={`px-4 pt-5 pb-4 sm:p-6 sm:pb-5 ${isFull ? 'flex-1 flex flex-col min-h-0' : ''}`}
          style={{
            paddingTop: isFull ? 'max(1.5rem, calc(env(safe-area-inset-top) + 0.75rem))' : undefined,
            paddingBottom: (hideCloseButton && !footerContent) ? 'max(1rem, calc(env(safe-area-inset-bottom) + 0.5rem))' : undefined
          }}
        >
          <div className="sm:flex sm:items-start w-full h-full">
            <div className={`mt-3 text-center sm:mt-0 sm:text-left w-full ${isFull ? 'flex-1 flex flex-col min-h-0' : ''}`}>
              {(title || !hideCloseButton) && (
                <div className="flex justify-between items-center mb-4">
                  {title && <h3 className="text-xl leading-6 font-semibold text-brand-primary" id="modal-title">{title}</h3>}
                  {!hideCloseButton && (
                    <button onClick={onClose} className="text-brand-muted hover:text-brand-text transition-colors duration-150">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                      </svg>
                      <span className="sr-only">Close modal</span>
                    </button>
                  )}
                </div>
              )}
              
              <div className={`mt-2 text-brand-lightText ${isFull ? 'flex-1 h-full' : 'max-h-[85vh] sm:max-h-[75vh]'} overflow-y-auto pr-2`}> {/* Scrollable area */}
                {children}
              </div>
            </div>
          </div>
        </div>
        {(footerContent || !hideCloseButton) && (
          <div 
            className="bg-brand-secondaryLight/50 px-4 py-3 sm:px-6 flex justify-end sm:flex-row-reverse items-center w-full"
            style={{ paddingBottom: 'max(0.75rem, calc(env(safe-area-inset-bottom) + 0.25rem))' }}
          >
            {footerContent}
            {!hideCloseButton && !footerContent && (
                 <Button onClick={onClose} variant="secondary" size="sm">
                    Close
                </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
  
  return createPortal(modalContent, document.body);
};
