import React, { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

interface PageTransitionProps {
    children: React.ReactNode;
    className?: string;
}

export const PageTransition: React.FC<PageTransitionProps> = ({ children, className = '' }) => {
    const containerRef = useRef<HTMLDivElement>(null);

    useGSAP(() => {
        // Animate content in
        gsap.fromTo(
            containerRef.current,
            { opacity: 0, y: 20, scale: 0.98 },
            { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: 'power2.out', clearProps: 'all' }
        );
    }, { scope: containerRef }); // Scope is important for cleanup

    return (
        <div ref={containerRef} className={`w-full ${className}`}>
            {children}
        </div>
    );
};
