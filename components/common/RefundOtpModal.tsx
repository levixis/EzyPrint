import React, { useState, useEffect } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

interface RefundOtpModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  onConfirm: (otp: string) => Promise<void>;
  onRequestOTP: () => Promise<void>;
  isIssuingRefund: boolean;
  isRequestingOTP: boolean;
  otpSent: boolean;
  resultMessage: { success: boolean; message: string } | null;
  children?: React.ReactNode;
}

export const RefundOtpModal: React.FC<RefundOtpModalProps> = ({
  isOpen,
  onClose,
  orderId,
  onConfirm,
  onRequestOTP,
  isIssuingRefund,
  isRequestingOTP,
  otpSent,
  resultMessage,
  children
}) => {
  const [otp, setOtp] = useState('');
  const [timeLeft, setTimeLeft] = useState(300); // 5 minutes in seconds

  useEffect(() => {
    if (isOpen && otpSent) {
      setTimeLeft(300);
      setOtp('');
    } else if (!isOpen) {
      setOtp('');
      setTimeLeft(300);
    }
  }, [isOpen, otpSent]);

  useEffect(() => {
    if (!isOpen || !otpSent || timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, otpSent, timeLeft]);

  const handleConfirm = () => {
    if (otp.length === 6) {
      onConfirm(otp);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Secure Refund Verification`}>
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Two-step security verification is required to process refunds for order <span className="font-bold font-mono">#{orderId.slice(-6)}</span>.
        </p>

        {!otpSent ? (
          <div className="flex flex-col items-center py-4 bg-gray-50 dark:bg-zinc-800/50 rounded-xl border border-gray-100 dark:border-zinc-700">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8 text-brand-primary">
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
              </svg>
            </div>
            
            {/* Custom Content Injection (like reason input, order details) */}
            {children && !otpSent && (
              <div className="w-full mb-4 px-2">
                {children}
              </div>
            )}
            
            <div className="w-full px-4">
              <Button 
                variant="primary" 
                onClick={onRequestOTP} 
                disabled={isRequestingOTP}
                className="!bg-gradient-to-r !from-brand-primary !to-red-600 w-full"
              >
                {isRequestingOTP ? 'Sending OTP...' : 'Request Verification Code'}
              </Button>
            </div>
          </div>
        ) : (
          <div className="bg-red-50 dark:bg-red-900/10 p-5 rounded-xl border border-red-100 dark:border-red-900/30 text-center animate-fade-in relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-red-200 dark:bg-red-800/50">
              <div 
                className="h-full bg-brand-primary transition-all duration-1000 ease-linear" 
                style={{ width: `${(timeLeft / 300) * 100}%` }}
              />
            </div>
            <h4 className="font-bold text-gray-900 dark:text-white mb-2 mt-2">Enter Verification Code</h4>
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-4">A 6-digit code has been sent to your admin email.</p>
            
            <input
              type="text"
              className="w-full text-center tracking-[0.5em] text-2xl font-bold p-3 rounded-lg border border-gray-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 mb-3 focus:ring-2 focus:ring-brand-primary outline-none uppercase"
              placeholder="000000"
              maxLength={6}
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/[^0-9]/g, ''))}
              autoFocus
            />

            <div className="flex justify-between items-center mb-5 px-1">
              {timeLeft > 0 ? (
                <span className="text-xs font-semibold text-brand-primary flex items-center gap-1.5 bg-red-100 dark:bg-red-900/50 px-2 py-1 rounded-full">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                    <path fillRule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clipRule="evenodd" />
                  </svg>
                  Expires in {formatTime(timeLeft)}
                </span>
              ) : (
                <span className="text-xs font-semibold text-red-500 w-full">Code expired. Please close and try again.</span>
              )}
              {resultMessage?.success === false && resultMessage.message.includes('attempts') && (
                 <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-widest animate-pulse">
                   Warning
                 </span>
              )}
            </div>

            <div className="flex gap-3">
              <Button variant="secondary" onClick={onClose} fullWidth disabled={isIssuingRefund}>
                Cancel
              </Button>
              <Button 
                variant="primary" 
                onClick={handleConfirm} 
                fullWidth 
                disabled={isIssuingRefund || otp.length < 6 || timeLeft <= 0} 
                className="!bg-gradient-to-r !from-emerald-500 !to-green-600"
              >
                {isIssuingRefund ? 'Verifying...' : 'Confirm Refund'}
              </Button>
            </div>
          </div>
        )}

        {resultMessage && (
          <div className={`p-3 rounded-lg text-sm font-medium animate-fade-in ${resultMessage.success ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
            <div className="flex items-start gap-2">
              <span className="mt-0.5">{resultMessage.success ? '✅' : '⚠️'}</span>
              <span>{resultMessage.message}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
