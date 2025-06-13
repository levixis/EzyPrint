
import React, { ReactNode } from 'react';

// Base props common to both button and anchor
interface BaseButtonProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent';
  size?: 'sm' | 'md' | 'lg';
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
  className?: string;
}

// Props when the component is a button
interface ButtonAsButtonProps extends BaseButtonProps, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  as?: 'button';
  type?: 'button' | 'submit' | 'reset'; // Override HTMLButtonElement's type for more specific use
  href?: undefined; // Ensure href is not present for button type
}

// Props when the component is an anchor
interface ButtonAsAnchorProps extends BaseButtonProps, Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'children'> {
  as: 'a';
  href: string; // href is required for anchor type
  type?: undefined; // Ensure button type is not present for anchor
}

// Union type for all possible props
type ButtonProps = ButtonAsButtonProps | ButtonAsAnchorProps;

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  size = 'md',
  className = '',
  leftIcon,
  rightIcon,
  fullWidth = false,
  as,
  ...props
}) => {
  const baseStyle = "font-semibold rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-brand-bg transition-all duration-200 ease-in-out inline-flex items-center justify-center shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed active:scale-95";
  
  const variantStyles = {
    primary: 'bg-brand-primary hover:bg-brand-primaryDark text-white focus:ring-brand-primaryDark',
    secondary: 'bg-brand-secondaryLight hover:bg-brand-secondary text-brand-text focus:ring-brand-muted border border-brand-muted',
    danger: 'bg-status-error hover:bg-red-700 text-white focus:ring-red-500', // Using status.error for consistency
    ghost: 'bg-transparent hover:bg-brand-secondaryLight text-brand-lightText focus:ring-brand-muted border border-brand-muted hover:border-brand-primary hover:text-brand-primary',
    accent: 'bg-brand-accent hover:opacity-80 text-white focus:ring-brand-accent', // New accent
  };

  const sizeStyles = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-7 py-3 text-base',
  };
  
  const widthStyle = fullWidth ? 'w-full' : '';

  const combinedClassName = `${baseStyle} ${variantStyles[variant]} ${sizeStyles[size]} ${widthStyle} ${className}`;

  const content = (
    <>
      {leftIcon && <span className={`mr-2 ${size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'}`}>{leftIcon}</span>}
      {children}
      {rightIcon && <span className={`ml-2 ${size === 'sm' ? 'h-4 w-4' : 'h-5 w-5'}`}>{rightIcon}</span>}
    </>
  );

  if (as === 'a') { 
    // Explicitly cast props to the anchor type to access href and other anchor attributes
    const anchorProps = props as Omit<ButtonAsAnchorProps, keyof BaseButtonProps | 'as'>;
    const { href, ...restAnchorProps } = anchorProps; // Destructure href
    return (
      <a
        className={combinedClassName}
        href={href} 
        {...restAnchorProps} // Spread the rest of the anchor-specific props
      >
        {content}
      </a>
    );
  }

  const buttonSpecificProps = props as Omit<ButtonAsButtonProps, keyof BaseButtonProps | 'as' | 'type'>;
  return (
    <button
      className={combinedClassName}
      type={(props as ButtonAsButtonProps).type || 'button'} 
      {...buttonSpecificProps} 
    >
      {content}
    </button>
  );
};
