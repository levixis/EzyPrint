
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

  const modalContent = (
    <div 
      className={`fixed inset-0 z-[100] overflow-y-auto flex items-end sm:items-center justify-center p-0 sm:p-4 transition-opacity duration-300 ease-out
                  ${isOpen ? 'opacity-100 bg-brand-bg/80 backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`}
      aria-labelledby="modal-title" 
      role="dialog" 
      aria-modal="true"
    >
      <div 
        className={`bg-brand-secondary rounded-t-2xl sm:rounded-xl text-left overflow-hidden shadow-modal transform transition-all duration-300 ease-out sm:my-8 sm:align-middle w-full ${sizeClasses[size]}
                    ${isOpen ? 'opacity-100 translate-y-0 sm:scale-100' : 'opacity-0 translate-y-8 sm:translate-y-0 sm:scale-95'}`}
      >
        <div className="px-4 pt-5 pb-4 sm:p-6 sm:pb-5">
          <div className="sm:flex sm:items-start w-full">
            <div className="mt-3 text-center sm:mt-0 sm:text-left w-full">
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
              
              <div className="mt-2 text-brand-lightText max-h-[70vh] sm:max-h-[75vh] overflow-y-auto pr-2"> {/* Added max-h and overflow-y-auto & pr-2 for scrollbar space */}
                {children}
              </div>
            </div>
          </div>
        </div>
        {(footerContent || !hideCloseButton) && (
          <div className="bg-brand-secondaryLight/50 px-4 py-3 sm:px-6 sm:flex sm:flex-row-reverse items-center">
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
