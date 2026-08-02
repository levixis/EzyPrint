
import React, { useState, useEffect, useRef } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Input } from '../common/Input';
import { Spinner } from '../common/Spinner';
import { UserType } from '../../types';
import { authApi } from '../../lib/queries';
// Firebase removed — logout handled via AppContext

const EzyPrintLogoIconLarge: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-16 h-16 text-brand-primary mb-4 mx-auto">
    <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z" />
    <path fill="none" d="M0 0h24v24H0z" />
  </svg>
);

const GoogleIcon: React.FC = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
    <path d="M22.56 12.25C22.56 11.47 22.49 10.72 22.36 10H12V14.5H18.2C17.96 15.99 17.15 17.24 15.93 18.09V20.58H19.53C21.43 18.84 22.56 15.83 22.56 12.25Z" fill="#4285F4" />
    <path d="M12 23C14.97 23 17.47 22.02 19.53 20.58L15.93 18.09C14.97 18.73 13.63 19.12 12 19.12C9.12 19.12 6.69 17.29 5.74 14.78L1.97 14.78V17.36C3.99 20.73 7.73 23 12 23Z" fill="#34A853" />
    <path d="M5.74 14.78C5.53 14.22 5.41 13.62 5.41 13C5.41 12.38 5.53 11.78 5.74 11.22V8.64L1.97 8.64C1.21 10.05 0.819995 11.48 0.819995 13C0.819995 14.52 1.21 15.95 1.97 17.36L5.74 14.78Z" fill="#FBBC05" />
    <path d="M12 6.88C13.78 6.88 15.17 7.53 15.93 8.23L19.61 4.93C17.47 3.09 14.97 2 12 2C7.73 2 3.99 4.27 1.97 8.64L5.74 11.22C6.69 8.71 9.12 6.88 12 6.88Z" fill="#EA4335" />
  </svg>
);

const MailIcon: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
    <path d="M3 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H3Zm12 2L10 10 5 6h10ZM4 14V8l5.5 3.5L15 8v6H4Z" />
  </svg>
);

const SESSION_STORAGE_INTENDED_TYPE_KEY = 'ezyprint_intendedUserType';
const SESSION_STORAGE_AUTH_METHOD_KEY = 'ezyprint_authMethod';

type LoginStep = 'pathSelection' | 'emailAuth' | 'shopOwnerDetails' | 'confirmGoogleUserName' | 'selectRoleForPendingProfile' | 'processing' | 'accountExists' | 'shopArchived' | 'forgotPassword' | 'resetPassword';
type AuthMode = 'google' | 'email';
type EmailSubMode = 'signin' | 'signup';

const LoginPage: React.FC = () => {
  const {
    signInWithGoogle,
    signInWithEmailAndPassword,
    signUpWithEmailPassword,
    isLoadingAuth,
    pendingFirebaseProfileCreationUser,
    completeShopOwnerProfileCreation,
    completeStudentProfileCreation,
    checkReturningShopOwner,
    submitReactivationRequest,
    currentUser,
    logoutUser,
  } = useAppContext();

  const [step, setStep] = useState<LoginStep>('pathSelection');
  const [authMode, setAuthMode] = useState<AuthMode>('google');
  const [emailSubMode, setEmailSubMode] = useState<EmailSubMode>('signin');

  const [nameForProfile, setNameForProfile] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [shopName, setShopName] = useState('');
  const [shopAddress, setShopAddress] = useState('');
  const [referralCode, setReferralCode] = useState('');

  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [archivedShopName, setArchivedShopName] = useState('');
  const [archivedShopId, setArchivedShopId] = useState('');
  const [isSubmittingReactivation, setIsSubmittingReactivation] = useState(false);
  const [reactivationSubmitted, setReactivationSubmitted] = useState(false);

  const [intendedUserTypeForSignup, setIntendedUserTypeForSignup] = useState<UserType | null>(null);
  const [authMethodForSignup, setAuthMethodForSignup] = useState<'google' | 'email' | null>(null);
  const isCheckingShopOwnerRef = useRef(false);

  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [isResetBusy, setIsResetBusy] = useState(false);

  const clearSessionStorageAuthFlow = () => {
    sessionStorage.removeItem(SESSION_STORAGE_INTENDED_TYPE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_AUTH_METHOD_KEY);
  };

  const handleProfileCreationResult = (result: { success: boolean; message?: string }, successStep: LoginStep | null = null, failureStep: LoginStep = 'pathSelection') => {
    if (!result.success) {
      setError(result.message || "Profile creation failed.");
      setStep(failureStep);
    } else {
      clearSessionStorageAuthFlow(); 
      if (successStep) setStep(successStep);
    }
  };

  const handleProfileCreationError = (err: unknown, failureStep: LoginStep = 'pathSelection') => {
    setError(err instanceof Error ? err.message : "An unexpected error occurred during profile creation.");
    setStep(failureStep);
  };

  useEffect(() => {

    if (currentUser) {
      clearSessionStorageAuthFlow();
      return;
    }

    // Attempt to restore state from sessionStorage on component mount/effect run if state is null
    let restoredAuthMethod = authMethodForSignup;
    if (!restoredAuthMethod) {
      const storedAuthMethod = sessionStorage.getItem(SESSION_STORAGE_AUTH_METHOD_KEY);
      if (storedAuthMethod === 'google' || storedAuthMethod === 'email') {
        setAuthMethodForSignup(storedAuthMethod as 'google' | 'email');
        restoredAuthMethod = storedAuthMethod as 'google' | 'email';
      }
    }

    let restoredIntendedType = intendedUserTypeForSignup;
    if (!restoredIntendedType) {
      const storedUserType = sessionStorage.getItem(SESSION_STORAGE_INTENDED_TYPE_KEY);
      if (storedUserType === UserType.STUDENT || storedUserType === UserType.SHOP_OWNER) {
        setIntendedUserTypeForSignup(storedUserType as UserType);
        restoredIntendedType = storedUserType as UserType;
      }
    }


    if (!isLoadingAuth && pendingFirebaseProfileCreationUser) {
      const authUser = pendingFirebaseProfileCreationUser;
      const currentAuthMethod = authMethodForSignup || restoredAuthMethod;
      const currentIntendedType = intendedUserTypeForSignup || restoredIntendedType;


      const checkAndHandleShopOwner = () => {
        if (step !== 'shopOwnerDetails' && step !== 'accountExists' && step !== 'shopArchived' && !isCheckingShopOwnerRef.current) {
          isCheckingShopOwnerRef.current = true;
          setStep('processing');
          checkReturningShopOwner(authUser.email || '')
            .then(res => {
              isCheckingShopOwnerRef.current = false;
              if (res.hasActiveAccount) {
                // Active account exists — block signup, redirect to sign-in
                setStep('accountExists');
              } else if (res.hasArchivedShop && res.shop) {
                // Archived shop — let user submit reactivation request directly
                setArchivedShopName(res.shop.name || 'your shop');
                setArchivedShopId(res.shop.id || '');
                setStep('shopArchived');
              } else {
                // Orphaned or no match — proceed with fresh registration
                setStep('shopOwnerDetails');
              }
            })
            .catch(err => {
              isCheckingShopOwnerRef.current = false;
              void err;
              setStep('shopOwnerDetails');
            });
        }
      };

      if (currentAuthMethod === 'email') {
        if (authMode !== 'email') setAuthMode('email');
        if (currentIntendedType === UserType.STUDENT) {
          if (step !== 'processing') setStep('processing');
          completeStudentProfileCreation(nameForProfile)
            .then(result => handleProfileCreationResult(result, null, 'emailAuth'))
            .catch(err => handleProfileCreationError(err, 'emailAuth'));
        } else if (currentIntendedType === UserType.SHOP_OWNER) {
          checkAndHandleShopOwner();
        } else {
          if (step !== 'selectRoleForPendingProfile') setStep('selectRoleForPendingProfile');
        }
      } else if (currentAuthMethod === 'google') {
        if (authMode !== 'google') setAuthMode('google');
        if (!nameForProfile && authUser.displayName) setNameForProfile(authUser.displayName);

        if (currentIntendedType === UserType.STUDENT) {
          if (step !== 'confirmGoogleUserName') setStep('confirmGoogleUserName');
        } else if (currentIntendedType === UserType.SHOP_OWNER) {
          checkAndHandleShopOwner();
        } else {
          if (step !== 'selectRoleForPendingProfile') setStep('selectRoleForPendingProfile');
        }
      } else {
        const providerDataArray = authUser.providerData;
        if (providerDataArray && providerDataArray.length > 0) {
          const providerId = providerDataArray[0]?.providerId;
          if (providerId === 'google.com') {
            sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'google');
            setAuthMethodForSignup('google');
            setAuthMode('google');
            if (!nameForProfile && authUser.displayName) setNameForProfile(authUser.displayName);
            return;
          } else if (providerId === 'password') {
            sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'email');
            setAuthMethodForSignup('email');
            setAuthMode('email');
            return;
          } else {
            handleAuthError(new Error(`Unknown authentication provider ID: ${providerId}`), "Pending Profile Resolution");
            handleCancelAndReset(false);
          }
        } else {
          handleAuthError(new Error("User authentication data (providerData) is incomplete."), "Pending Profile Resolution");
          handleCancelAndReset(false);
        }
      }
    } else if (!pendingFirebaseProfileCreationUser && !currentUser && !isLoadingAuth) {
      const intermediateSteps: LoginStep[] = ['processing', 'confirmGoogleUserName', 'shopOwnerDetails', 'selectRoleForPendingProfile', 'accountExists', 'shopArchived'];
      if (intermediateSteps.includes(step)) {
        handleCancelAndReset(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isLoadingAuth, currentUser, pendingFirebaseProfileCreationUser,
    intendedUserTypeForSignup, authMethodForSignup, nameForProfile,
    completeStudentProfileCreation, completeShopOwnerProfileCreation, checkReturningShopOwner,
    step, authMode
  ]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleAuthError = (error: unknown, _context: string): string => {
    const message = error instanceof Error ? error.message : "An unexpected error occurred.";
    setError(message);
    return message;
  };

  const handleEmailPasswordSignUp = async (userType: UserType) => {
    setError(''); setMessage('');
    if (emailSubMode === 'signup' && !nameForProfile.trim()) { setError("Full name is required for sign up."); return; }
    if (!email.trim() || !password.trim()) { setError("Email and password are required."); return; }

    if (emailSubMode === 'signup') {
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (!/[A-Z]/.test(password)) { setError("Password must include at least one uppercase letter."); return; }
      if (!/[a-z]/.test(password)) { setError("Password must include at least one lowercase letter."); return; }
      if (!/[0-9]/.test(password)) { setError("Password must include at least one number."); return; }
      if (!/[^A-Za-z0-9]/.test(password)) { setError("Password must include at least one special character."); return; }
    }

    sessionStorage.setItem(SESSION_STORAGE_INTENDED_TYPE_KEY, userType);
    sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'email');
    setIntendedUserTypeForSignup(userType);
    setAuthMethodForSignup('email');
    setStep('processing');
    const result = await signUpWithEmailPassword(email, password, nameForProfile);
    if (!result.success) {
      setError(result.message || "Sign up failed.");
      setStep('emailAuth');
      // Do not clear session storage here, useEffect will handle if user refreshes.
    }
  };

  const handleEmailPasswordSignIn = async () => {
    setError(''); setMessage('');
    if (!email.trim() || !password.trim()) { setError("Email and password are required."); return; }

    sessionStorage.removeItem(SESSION_STORAGE_INTENDED_TYPE_KEY); // Not a signup flow
    sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'email'); // Still useful for refresh
    setAuthMethodForSignup('email');
    setIntendedUserTypeForSignup(null);
    // Keep step as 'emailAuth' (not 'processing') to prevent the useEffect
    // guard from resetting the form when isLoadingAuth toggles
    const result = await signInWithEmailAndPassword(email, password);
    if (!result.success) {
      // Show the actual backend error (e.g. "Invalid email or password")
      // Don't assume the account doesn't exist — they may just have the wrong password
      setError(result.message || "Sign in failed. Please check your credentials.");
      setStep('emailAuth');
      // Stay on sign-in mode so user can retry with correct password
    }
  };

  /**
   * Ask for a reset code.
   *
   * Advances to the code screen regardless of the outcome, and the wording
   * never claims the address was found. The server answers identically for a
   * registered and an unregistered address on purpose — reporting "no such
   * account" here would undo that and turn the login screen into a way to test
   * which campus addresses are registered.
   */
  const handleForgotPasswordRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    if (!email.trim()) { setError("Enter the email you sign in with."); return; }

    setIsResetBusy(true);
    try {
      await authApi.forgotPassword(email.trim());
      setResetCode('');
      setNewPassword('');
      setStep('resetPassword');
      setMessage(`If ${email.trim()} has an EzyPrint account, a 6-digit code is on its way. It expires in 5 minutes.`);
    } catch (err) {
      // Reaches here for a rate limit or a dead backend — both are worth
      // showing, and neither reveals whether the account exists.
      setError(err instanceof Error ? err.message : "Could not send a reset code. Please try again.");
    } finally {
      setIsResetBusy(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setMessage('');
    if (!/^[0-9]{6}$/.test(resetCode.trim())) { setError("Enter the 6-digit code from the email."); return; }
    // Mirrors the server's rules so a weak password is caught before a round
    // trip — and, more to the point, before the one-use code is spent on it.
    if (newPassword.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (!/[A-Z]/.test(newPassword)) { setError("Password must include at least one uppercase letter."); return; }
    if (!/[a-z]/.test(newPassword)) { setError("Password must include at least one lowercase letter."); return; }
    if (!/[0-9]/.test(newPassword)) { setError("Password must include at least one number."); return; }
    if (!/[^A-Za-z0-9]/.test(newPassword)) { setError("Password must include at least one special character."); return; }

    setIsResetBusy(true);
    try {
      await authApi.resetPassword(email.trim(), resetCode.trim(), newPassword);
      setPassword('');
      setResetCode('');
      setNewPassword('');
      setStep('emailAuth');
      setEmailSubMode('signin');
      setMessage("Password updated. Sign in with your new password.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password. Please try again.");
    } finally {
      setIsResetBusy(false);
    }
  };

  const handleGoogleStudentNameConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameForProfile.trim()) { setError("Name cannot be empty."); return; }
    if (pendingFirebaseProfileCreationUser) {
      setStep('processing');
      const result = await completeStudentProfileCreation(nameForProfile);
      handleProfileCreationResult(result, null, 'confirmGoogleUserName');
    } else {
      setError("Authentication session lost. Please try signing in again.");
      handleCancelAndReset(false);
    }
  };

  const handleShopOwnerDetailsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if ((authMethodForSignup === 'google' || emailSubMode === 'signup') && !nameForProfile.trim()) {
      setError("Your full name is required."); return;
    }
    if (!shopName.trim() || !shopAddress.trim()) {
      setError("Please enter shop name and address."); return;
    }
    if (!referralCode.trim()) {
      setError("A valid referral code is required."); return;
    }

    if (pendingFirebaseProfileCreationUser) {
      setStep('processing');
      const result = await completeShopOwnerProfileCreation(
        { shopName, shopAddress, referralCode },
        nameForProfile
      );
      handleProfileCreationResult(result, null, 'shopOwnerDetails');
    } else {
      setError("Authentication session lost. Please try signing in again.");
      handleCancelAndReset(false);
    }
  };

  const handleRoleSelectedForPendingProfile = (userType: UserType) => {
    sessionStorage.setItem(SESSION_STORAGE_INTENDED_TYPE_KEY, userType);
    setIntendedUserTypeForSignup(userType);
    // useEffect will pick this up
  };

  const switchAuthUIMode = (newMode: AuthMode) => {
    setAuthMode(newMode);
    setError(''); setMessage('');
    setStep(newMode === 'google' ? 'pathSelection' : 'emailAuth');
    if (newMode === 'email') setEmailSubMode('signin');
  };

  const handleCancelAndReset = async (softReset = false) => {
    setError(''); setMessage('');
    isCheckingShopOwnerRef.current = false;

    if (!softReset) { // Hard reset
      clearSessionStorageAuthFlow();
      if (pendingFirebaseProfileCreationUser) {
        setStep('processing');
        await logoutUser();
      }
      setIntendedUserTypeForSignup(null);
      setAuthMethodForSignup(null);
    } else {
      // Soft reset logic here (currently empty)
    }

    // Common reset for both soft and hard, except for critical flow states on soft.
    setNameForProfile('');
    setEmail('');
    setPassword('');
    setShopName('');
    setShopAddress('');

    if (!softReset) {
      setAuthMode('google');
    }
    setStep('pathSelection');
  };

  if (isLoadingAuth && step !== 'processing' && !pendingFirebaseProfileCreationUser && !currentUser) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[70vh]">
        <Spinner size="lg" />
        <p className="mt-4 text-brand-lightText">Loading authentication...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[calc(100vh-150px)] py-12 px-4">
      <div className="text-center mb-8">
        <EzyPrintLogoIconLarge />
        <h1 className="text-4xl sm:text-5xl font-extrabold mb-1">
          <span className="text-brand-text dark:text-white">EZY</span><span className="text-brand-primary">PRINT</span>
        </h1>
        <p className="text-sm text-brand-primaryDark font-semibold tracking-wider">PAY PRINT COLLECT</p>
      </div>

      <Card className="w-full max-w-md bg-brand-secondary/90 backdrop-blur-md">
        {error && <p className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 text-sm rounded-md text-center border border-red-200 dark:border-red-800" role="alert">{error}</p>}
        {message && !error && <p className="mb-4 p-3 bg-status-info/20 text-status-info text-sm rounded-md text-center" role="status">{message}</p>}

        {step === 'processing' && (
          <div className="p-8 text-center">
            <Spinner size="lg" />
            <p className="mt-4 text-brand-lightText">Processing... Please wait.</p>
          </div>
        )}

        {/*
          Hidden during the reset flow as well as the profile sub-flows: those
          screens carry their own way back, and a tab switch mid-reset would
          silently drop a code the user is holding.
        */}
        {step !== 'processing' && step !== 'shopOwnerDetails' && step !== 'confirmGoogleUserName' && step !== 'selectRoleForPendingProfile' && step !== 'forgotPassword' && step !== 'resetPassword' && (
          <div className="flex border-b border-brand-muted/30 mb-1">
            <button
              onClick={() => switchAuthUIMode('google')}
              className={`flex-1 py-3 text-sm font-medium transition-colors duration-150 focus:outline-none ${authMode === 'google' ? 'text-brand-primary border-b-2 border-brand-primary' : 'text-brand-muted hover:text-brand-lightText'}`}
              aria-pressed={authMode === 'google'}
            >
              Use Google
            </button>
            <button
              onClick={() => switchAuthUIMode('email')}
              className={`flex-1 py-3 text-sm font-medium transition-colors duration-150 focus:outline-none ${authMode === 'email' ? 'text-brand-primary border-b-2 border-brand-primary' : 'text-brand-muted hover:text-brand-lightText'}`}
              aria-pressed={authMode === 'email'}
            >
              Use Email
            </button>
          </div>
        )}


        {step === 'pathSelection' && authMode === 'google' && (
          <div className="space-y-5 p-4 pt-6 text-center">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Welcome to EzyPrint</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Sign in with your Google account to continue</p>
            <Button onClick={() => signInWithGoogle()} variant="primary" size="lg" fullWidth leftIcon={<GoogleIcon />} className="!bg-white !text-gray-700 !border !border-gray-300 hover:!bg-gray-50 dark:!bg-zinc-800 dark:!text-white dark:!border-zinc-600 dark:hover:!bg-zinc-700">
              Sign in with Google
            </Button>
          </div>
        )}

        {step === 'emailAuth' && authMode === 'email' && (
          <div className="space-y-4 p-4 pt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-3">
              {emailSubMode === 'signin' ? 'Sign In with Email' : 'Create New Account'}
            </h2>
            {emailSubMode === 'signup' && (
              <Input label="Full Name" id="nameForProfile" type="text" value={nameForProfile} onChange={(e) => setNameForProfile(e.target.value)} placeholder="e.g. Alex Doe" required />
            )}
            <Input label="Email Address" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
            <Input label="Password" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />

            {emailSubMode === 'signin' ? (
              <>
                <Button type="button" onClick={handleEmailPasswordSignIn} variant="primary" size="lg" fullWidth className="mt-5" leftIcon={<MailIcon />}>
                  Sign In
                </Button>
                <p className="text-center text-xs my-3">
                  <button
                    onClick={() => { setStep('forgotPassword'); setError(''); setMessage(''); }}
                    className="font-semibold text-brand-primary hover:underline focus:outline-none"
                  >
                    Forgot password?
                  </button>
                </p>
                <p className="text-center text-xs text-gray-500 dark:text-gray-400 my-3">
                  Don't have an account?{' '}
                  <button onClick={() => { setEmailSubMode('signup'); setError(''); }} className="font-semibold text-brand-primary hover:underline focus:outline-none">
                    Sign Up
                  </button>
                </p>
              </>
            ) : (
              <>
                <p className="text-center text-xs text-gray-500 dark:text-gray-400 my-1">SIGN UP AS:</p>
                <div className="grid grid-cols-2 gap-3">
                  <Button onClick={() => handleEmailPasswordSignUp(UserType.STUDENT)} variant="secondary" size="md" fullWidth>
                    New Student
                  </Button>
                  <Button onClick={() => handleEmailPasswordSignUp(UserType.SHOP_OWNER)} variant="secondary" size="md" fullWidth>
                    New Shop Owner
                  </Button>
                </div>
                <p className="text-center text-xs text-brand-muted mt-3">
                  Already have an account?{' '}
                  <button onClick={() => { setEmailSubMode('signin'); setError(''); }} className="font-semibold text-brand-primary hover:underline focus:outline-none">
                    Sign In
                  </button>
                </p>
              </>
            )}
          </div>
        )}

        {step === 'forgotPassword' && (
          <form onSubmit={handleForgotPasswordRequest} className="space-y-4 p-4 pt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-1">Reset your password</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-3">
              We'll email you a 6-digit code.
            </p>

            {/*
              The Google route first. Most people here signed up with Google and
              have no password to reset — signing in is one tap and needs no
              email at all. Offering the code to them anyway would be a slower
              answer to a question they do not have.
            */}
            <div className="p-3 rounded-md bg-status-info/10 border border-status-info/30">
              <p className="text-xs text-gray-600 dark:text-gray-300">
                <strong className="text-gray-900 dark:text-white">Signed up with Google?</strong>{' '}
                You don't have a password — just use Google and you're in.
              </p>
              <Button
                type="button"
                onClick={() => signInWithGoogle()}
                variant="secondary"
                size="sm"
                fullWidth
                className="mt-2"
                leftIcon={<GoogleIcon />}
              >
                Sign in with Google
              </Button>
            </div>

            <Input
              label="Email Address"
              id="forgotEmail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
            <Button type="submit" variant="primary" size="lg" fullWidth disabled={isResetBusy} leftIcon={<MailIcon />}>
              {isResetBusy ? 'Sending…' : 'Send reset code'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              fullWidth
              className="!text-xs"
              onClick={() => { setStep('emailAuth'); setEmailSubMode('signin'); setError(''); setMessage(''); }}
            >
              Back to sign in
            </Button>
          </form>
        )}

        {step === 'resetPassword' && (
          <form onSubmit={handleResetPassword} className="space-y-4 p-4 pt-6">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white text-center mb-1">Enter your code</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center mb-3">
              Check your inbox — and your spam folder.
            </p>
            <Input
              label="6-digit code"
              id="resetCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={resetCode}
              onChange={(e) => setResetCode(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="123456"
              required
            />
            <Input
              label="New Password"
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
            <p className="text-xs text-gray-500 dark:text-gray-400">
              At least 8 characters, with an uppercase and lowercase letter, a number and a symbol.
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Resetting signs you out on every device.
            </p>
            <Button type="submit" variant="primary" size="lg" fullWidth disabled={isResetBusy}>
              {isResetBusy ? 'Updating…' : 'Set new password'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              fullWidth
              className="!text-xs"
              onClick={() => { setStep('forgotPassword'); setError(''); setMessage(''); }}
            >
              Didn't get a code? Send another
            </Button>
          </form>
        )}

        {step === 'selectRoleForPendingProfile' && pendingFirebaseProfileCreationUser && (
          <div className="space-y-5 p-4 pt-6 text-center">
            <h2 className="text-xl font-semibold text-brand-text mb-1">Complete Your Profile</h2>
            <p className="text-sm text-brand-lightText mb-4">
              Welcome, {nameForProfile || pendingFirebaseProfileCreationUser.displayName || pendingFirebaseProfileCreationUser.email}!
              Please specify your role to continue:
            </p>
            <Button onClick={() => handleRoleSelectedForPendingProfile(UserType.STUDENT)} variant="primary" size="lg" fullWidth>
              I am a Student
            </Button>
            <Button onClick={() => handleRoleSelectedForPendingProfile(UserType.SHOP_OWNER)} variant="secondary" size="lg" fullWidth>
              I am a Shop Owner
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => handleCancelAndReset(false)} fullWidth className="mt-4 !text-xs">
              Cancel and Start Over
            </Button>
          </div>
        )}

        {step === 'confirmGoogleUserName' && pendingFirebaseProfileCreationUser && (
          <form onSubmit={handleGoogleStudentNameConfirm} className="space-y-5 p-4 pt-6">
            <h2 className="text-xl font-semibold text-brand-text text-center">Confirm Your Name</h2>
            <p className="text-sm text-brand-lightText text-center">
              We've fetched your name as "{nameForProfile || pendingFirebaseProfileCreationUser.displayName}". You can use it as is or change it below.
            </p>
            <Input
              label="Your Full Name"
              id="googleDisplayName"
              type="text"
              value={nameForProfile}
              onChange={(e) => setNameForProfile(e.target.value)}
              placeholder="e.g. Alex Doe"
              required
            />
            <Button type="submit" variant="primary" size="lg" fullWidth>
              Complete Student Registration
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => handleCancelAndReset(false)} fullWidth>
              Back / Cancel
            </Button>
          </form>
        )}

        {step === 'shopOwnerDetails' && pendingFirebaseProfileCreationUser && (
          <form onSubmit={handleShopOwnerDetailsSubmit} className="space-y-5 p-4 pt-6">
            <h2 className="text-xl font-semibold text-brand-text text-center">Complete Shop Owner Registration</h2>
            {(authMethodForSignup === 'email' || (authMethodForSignup === 'google' && !pendingFirebaseProfileCreationUser.displayName) || nameForProfile) && (
              <Input
                label="Your Full Name (Owner)"
                id="shopOwnerFullName"
                type="text"
                value={nameForProfile}
                onChange={(e) => setNameForProfile(e.target.value)}
                placeholder="e.g. Alex Doe"
                required
              />
            )}
            <p className="text-sm text-brand-lightText text-center -mt-3">
              Welcome, {nameForProfile || (pendingFirebaseProfileCreationUser.displayName || 'Shop Owner')}! Please provide your shop details.
            </p>
            <Input label="Shop Name" id="shopName" type="text" value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="My Awesome Print Shop" required />
            <Input label="Shop Address (Short)" id="shopAddress" type="text" value={shopAddress} onChange={(e) => setShopAddress(e.target.value)} placeholder="Main Street, Near Campus" required />
            <Input label="Referral Code" id="referralCode" type="text" value={referralCode} onChange={(e) => setReferralCode(e.target.value.toUpperCase())} placeholder="EZY-XXXXXX" required />
            <Button type="submit" variant="primary" size="lg" fullWidth>
              Register Shop & Login
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => handleCancelAndReset(false)} fullWidth>
              Back / Cancel
            </Button>
          </form>
        )}

        {step === 'accountExists' && (
          <div className="space-y-5 p-4 pt-6 text-center">
            <div className="w-16 h-16 mx-auto bg-amber-100 dark:bg-amber-900/30 rounded-full flex items-center justify-center mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-amber-600 dark:text-amber-400">
                <path fillRule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.29 4.5-2.599 4.5H4.645c-2.309 0-3.752-2.5-2.598-4.5L9.4 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Account Already Exists</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              An active shop owner account with this email already exists. Please sign out and sign in with your existing credentials.
            </p>
            <Button
              onClick={async () => { await logoutUser(); handleCancelAndReset(false); setEmailSubMode('signin'); }}
              variant="primary" size="lg" fullWidth
            >
              Sign Out & Sign In
            </Button>
            <Button
              type="button" variant="ghost" size="sm"
              onClick={() => handleCancelAndReset(false)} fullWidth className="!text-xs"
            >
              Cancel
            </Button>
          </div>
        )}

        {step === 'shopArchived' && (
          <div className="space-y-5 p-4 pt-6 text-center">
            <div className="w-16 h-16 mx-auto bg-blue-100 dark:bg-blue-900/30 rounded-full flex items-center justify-center mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-8 h-8 text-blue-600 dark:text-blue-400">
                <path d="M3.375 3C2.339 3 1.5 3.84 1.5 4.875v.75c0 1.036.84 1.875 1.875 1.875h17.25c1.035 0 1.875-.84 1.875-1.875v-.75C22.5 3.839 21.66 3 20.625 3H3.375Z" />
                <path fillRule="evenodd" d="m3.087 9 .54 9.176A3 3 0 0 0 6.62 21h10.757a3 3 0 0 0 2.995-2.824L20.913 9H3.087Zm6.163 3.75A.75.75 0 0 1 10 12h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Z" clipRule="evenodd" />
              </svg>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Shop Archived</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Your shop <strong>"{archivedShopName}"</strong> has been archived by the admin. You can request reactivation below.
            </p>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
                {error}
              </p>
            )}

            {reactivationSubmitted ? (
              <div className="bg-emerald-50 dark:bg-emerald-900/20 px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-800">
                <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                  ✅ Reactivation request submitted! The admin will review it shortly.
                </p>
              </div>
            ) : (
              <Button
                onClick={async () => {
                  if (!archivedShopId) { setError('Could not identify the shop.'); return; }
                  setIsSubmittingReactivation(true); setError('');
                  const result = await submitReactivationRequest(archivedShopId, archivedShopName);
                  setIsSubmittingReactivation(false);
                  if (result.success) {
                    setReactivationSubmitted(true);
                  } else {
                    if (result.message?.includes('already pending')) {
                      setReactivationSubmitted(true);
                    } else {
                      setError(result.message || 'Failed to submit request.');
                    }
                  }
                }}
                variant="primary" size="lg" fullWidth
                disabled={isSubmittingReactivation}
              >
                {isSubmittingReactivation ? 'Submitting...' : '📨 Request Reactivation'}
              </Button>
            )}

            <Button
              type="button" variant="ghost" size="sm"
              onClick={async () => { await logoutUser(); handleCancelAndReset(false); }} fullWidth className="!text-xs"
            >
              Sign Out
            </Button>
          </div>
        )}
      </Card>
      <p className="mt-8 text-xs text-gray-500 dark:text-gray-400 text-center max-w-md px-2">
        Your information is managed securely. By signing in or creating an account, you agree to our terms.
      </p>
    </div>
  );
};

export default LoginPage;
