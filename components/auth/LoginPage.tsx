
import React, { useState, useEffect } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { Button } from '../common/Button';
import { Card } from '../common/Card';
import { Input } from '../common/Input';
import { Spinner } from '../common/Spinner';
import { UserType } from '../../types';
import { signOut } from 'firebase/auth'; 
import { auth } from '../../firebase'; 

const EzyPrintLogoIconLarge: React.FC = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-16 h-16 text-brand-primary mb-4 mx-auto">
    <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7H5v-1c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v1zm-1-9H6v4h12V3z"/>
    <path fill="none" d="M0 0h24v24H0z"/>
  </svg>
);

const GoogleIcon: React.FC = () => (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25C22.56 11.47 22.49 10.72 22.36 10H12V14.5H18.2C17.96 15.99 17.15 17.24 15.93 18.09V20.58H19.53C21.43 18.84 22.56 15.83 22.56 12.25Z" fill="#4285F4"/>
        <path d="M12 23C14.97 23 17.47 22.02 19.53 20.58L15.93 18.09C14.97 18.73 13.63 19.12 12 19.12C9.12 19.12 6.69 17.29 5.74 14.78L1.97 14.78V17.36C3.99 20.73 7.73 23 12 23Z" fill="#34A853"/>
        <path d="M5.74 14.78C5.53 14.22 5.41 13.62 5.41 13C5.41 12.38 5.53 11.78 5.74 11.22V8.64L1.97 8.64C1.21 10.05 0.819995 11.48 0.819995 13C0.819995 14.52 1.21 15.95 1.97 17.36L5.74 14.78Z" fill="#FBBC05"/>
        <path d="M12 6.88C13.78 6.88 15.17 7.53 15.93 8.23L19.61 4.93C17.47 3.09 14.97 2 12 2C7.73 2 3.99 4.27 1.97 8.64L5.74 11.22C6.69 8.71 9.12 6.88 12 6.88Z" fill="#EA4335"/>
    </svg>
);

const MailIcon: React.FC = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
        <path d="M3 4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H3Zm12 2L10 10 5 6h10ZM4 14V8l5.5 3.5L15 8v6H4Z" />
    </svg>
);

const SESSION_STORAGE_INTENDED_TYPE_KEY = 'ezyprint_intendedUserType';
const SESSION_STORAGE_AUTH_METHOD_KEY = 'ezyprint_authMethod';

type LoginStep = 'pathSelection' | 'emailAuth' | 'shopOwnerDetails' | 'confirmGoogleUserName' | 'selectRoleForPendingProfile' | 'processing'; 
type AuthMode = 'google' | 'email';
type EmailSubMode = 'signin' | 'signup';

const LoginPage: React.FC = () => {
  const { 
    signInWithGoogle, 
    signUpWithEmailPassword,
    signInWithEmailAndPassword, 
    completeStudentProfileCreation, 
    completeShopOwnerProfileCreation,
    isLoadingAuth, 
    currentUser, 
    pendingFirebaseProfileCreationUser,
  } = useAppContext();
  
  const [step, setStep] = useState<LoginStep>('pathSelection');
  const [authMode, setAuthMode] = useState<AuthMode>('google'); 
  const [emailSubMode, setEmailSubMode] = useState<EmailSubMode>('signin');
  
  const [nameForProfile, setNameForProfile] = useState(''); 
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  
  const [shopName, setShopName] = useState('');
  const [shopAddress, setShopAddress] = useState('');
  
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  
  const [intendedUserTypeForSignup, setIntendedUserTypeForSignup] = useState<UserType | null>(null);
  const [authMethodForSignup, setAuthMethodForSignup] = useState<'google' | 'email' | null>(null);

  const clearSessionStorageAuthFlow = () => {
    sessionStorage.removeItem(SESSION_STORAGE_INTENDED_TYPE_KEY);
    sessionStorage.removeItem(SESSION_STORAGE_AUTH_METHOD_KEY);
    console.log("[LoginPage/SessionStorage] Cleared auth flow state from session storage.");
  };

  const handleProfileCreationResult = (result: {success: boolean; message?: string}, successStep: LoginStep | null = null, failureStep: LoginStep = 'pathSelection') => {
    if (!result.success) {
      setError(result.message || "Profile creation failed.");
      setStep(failureStep);
    } else {
      clearSessionStorageAuthFlow(); // Clear on successful profile creation
      if (successStep) setStep(successStep);
    }
  };
  
  const handleProfileCreationError = (err: any, failureStep: LoginStep = 'pathSelection') => {
    setError(err.message || "An unexpected error occurred during profile creation.");
    setStep(failureStep);
  };

  useEffect(() => {
    const logPrefix = '[LoginPage/useEffect]';

    if (currentUser) {
      console.log(`${logPrefix} CurrentUser exists (ID: ${currentUser.id}). Clearing session storage and returning.`);
      clearSessionStorageAuthFlow();
      return; 
    }
    
    // Attempt to restore state from sessionStorage on component mount/effect run if state is null
    let restoredAuthMethod = authMethodForSignup;
    if (!restoredAuthMethod) {
        const storedAuthMethod = sessionStorage.getItem(SESSION_STORAGE_AUTH_METHOD_KEY);
        if (storedAuthMethod === 'google' || storedAuthMethod === 'email') {
            console.log(`${logPrefix} Restored authMethodForSignup from sessionStorage: ${storedAuthMethod}`);
            setAuthMethodForSignup(storedAuthMethod as 'google' | 'email');
            restoredAuthMethod = storedAuthMethod as 'google' | 'email';
        }
    }

    let restoredIntendedType = intendedUserTypeForSignup;
    if (!restoredIntendedType) {
        const storedUserType = sessionStorage.getItem(SESSION_STORAGE_INTENDED_TYPE_KEY);
        if (storedUserType === UserType.STUDENT || storedUserType === UserType.SHOP_OWNER) {
            console.log(`${logPrefix} Restored intendedUserTypeForSignup from sessionStorage: ${storedUserType}`);
            setIntendedUserTypeForSignup(storedUserType as UserType);
            restoredIntendedType = storedUserType as UserType;
        }
    }


    if (!isLoadingAuth && pendingFirebaseProfileCreationUser) {
      const authUser = pendingFirebaseProfileCreationUser;
      const currentAuthMethod = authMethodForSignup || restoredAuthMethod;
      const currentIntendedType = intendedUserTypeForSignup || restoredIntendedType;

      const baseLogInfo = `UID: ${authUser.uid}, Step: ${step}, AuthMethod: ${currentAuthMethod}, IntendedType: ${currentIntendedType}, Name: "${nameForProfile}"`;
      console.log(`${logPrefix} Detected pendingFirebaseProfileCreationUser. ${baseLogInfo}`);

      if (currentAuthMethod === 'email') {
        console.log(`${logPrefix}   -> Branch: Email flow active.`);
        if (authMode !== 'email') setAuthMode('email'); 
        if (currentIntendedType === UserType.STUDENT) {
          console.log(`${logPrefix}     -> Action: Email Student. Processing profile.`);
          if (step !== 'processing') setStep('processing');
          completeStudentProfileCreation(authUser, nameForProfile)
              .then(result => handleProfileCreationResult(result, null, 'emailAuth'))
              .catch(err => handleProfileCreationError(err, 'emailAuth'));
        } else if (currentIntendedType === UserType.SHOP_OWNER) {
          console.log(`${logPrefix}     -> Action: Email Shop Owner. To shopOwnerDetails.`);
          if (step !== 'shopOwnerDetails') setStep('shopOwnerDetails');
        } else { 
          console.log(`${logPrefix}     -> Action: Email flow, role not specified. To selectRoleForPendingProfile.`);
          if (step !== 'selectRoleForPendingProfile') setStep('selectRoleForPendingProfile');
        }
      } else if (currentAuthMethod === 'google') {
        console.log(`${logPrefix}   -> Branch: Google flow active.`);
        if (authMode !== 'google') setAuthMode('google');
        if (!nameForProfile && authUser.displayName) setNameForProfile(authUser.displayName);

        if (currentIntendedType === UserType.STUDENT) {
          console.log(`${logPrefix}     -> Action: Google Student. To confirmGoogleUserName.`);
          if (step !== 'confirmGoogleUserName') setStep('confirmGoogleUserName');
        } else if (currentIntendedType === UserType.SHOP_OWNER) {
          console.log(`${logPrefix}     -> Action: Google Shop Owner. To shopOwnerDetails.`);
          if (step !== 'shopOwnerDetails') setStep('shopOwnerDetails');
        } else { 
          console.error(`${logPrefix}     -> Fallback: Google flow, but intendedUserType is null (after restore attempt). To selectRoleForPendingProfile.`);
          if (step !== 'selectRoleForPendingProfile') setStep('selectRoleForPendingProfile');
        }
      } else { 
        console.log(`${logPrefix}   -> Branch: Refresh/Load with pending user. authMethodForSignup is null (even after restore). Deducing method...`);
        const providerDataArray = authUser.providerData;
        if (providerDataArray && providerDataArray.length > 0) {
            const providerId = providerDataArray[0]?.providerId;
            if (providerId === 'google.com') {
              console.log(`${logPrefix}     -> Deduced: Google user. Setting authMethodForSignup to 'google'. Storing to session. Will re-run useEffect.`);
              sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'google');
              setAuthMethodForSignup('google'); 
              setAuthMode('google');
              if (!nameForProfile && authUser.displayName) setNameForProfile(authUser.displayName);
              return; 
            } else if (providerId === 'password') {
              console.log(`${logPrefix}     -> Deduced: Email user. Setting authMethodForSignup to 'email'. Storing to session. Will re-run useEffect.`);
              sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'email');
              setAuthMethodForSignup('email');
              setAuthMode('email');
              return; 
            } else {
              console.error(`${logPrefix}     -> Error: Unknown provider ID ('${providerId}') on load. Resetting.`);
              handleAuthError(new Error(`Unknown authentication provider ID: ${providerId}`), "Pending Profile Resolution");
              handleCancelAndReset(false); 
            }
        } else {
            console.error(`${logPrefix}     -> Error: Auth user providerData is missing or empty. Resetting.`);
            handleAuthError(new Error("User authentication data (providerData) is incomplete."), "Pending Profile Resolution");
            handleCancelAndReset(false); 
        }
      }
    } else if (!pendingFirebaseProfileCreationUser && !currentUser && !isLoadingAuth) {
      const intermediateSteps: LoginStep[] = ['processing', 'confirmGoogleUserName', 'shopOwnerDetails', 'selectRoleForPendingProfile'];
      if (intermediateSteps.includes(step)) {
          console.log(`${logPrefix} In intermediate step '${step}' but no authUser/pendingUser. Resetting flow (soft).`);
          handleCancelAndReset(true); 
      }
    }
  }, [
    isLoadingAuth, currentUser, pendingFirebaseProfileCreationUser, 
    intendedUserTypeForSignup, authMethodForSignup, nameForProfile, 
    completeStudentProfileCreation, completeShopOwnerProfileCreation, 
    step, authMode
  ]);

  const handleAuthError = (error: any, context: string): string => { 
    console.error(`[LoginPage] Auth Error (${context}):`, error);
    const message = error.message || "An unexpected error occurred.";
    setError(message);
    return message;
  };

  const handleGoogleSignIn = async (userType: UserType) => {
    setError(''); setMessage('');
    console.log(`[LoginPage/handleGoogleSignIn] UserType selected: ${userType}. Storing to component state and session storage.`);
    sessionStorage.setItem(SESSION_STORAGE_INTENDED_TYPE_KEY, userType);
    sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'google');
    setIntendedUserTypeForSignup(userType); 
    setAuthMethodForSignup('google');
    setStep('processing');
    await signInWithGoogle(); 
  };

  const handleEmailPasswordSignUp = async (userType: UserType) => {
    setError(''); setMessage('');
    if (emailSubMode === 'signup' && !nameForProfile.trim()) { setError("Full name is required for sign up."); return; }
    if (!email.trim() || !password.trim()) { setError("Email and password are required."); return; }
    console.log(`[LoginPage/handleEmailPasswordSignUp] UserType: ${userType}, Name: ${nameForProfile}. Storing to component state and session storage.`);
    
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
    console.log(`[LoginPage/handleEmailPasswordSignIn] Email: ${email}. Clearing intended type from session storage.`);
    
    sessionStorage.removeItem(SESSION_STORAGE_INTENDED_TYPE_KEY); // Not a signup flow
    sessionStorage.setItem(SESSION_STORAGE_AUTH_METHOD_KEY, 'email'); // Still useful for refresh
    setAuthMethodForSignup('email'); 
    setIntendedUserTypeForSignup(null); 
    setStep('processing');
    const result = await signInWithEmailAndPassword(email, password); 
    if (!result.success) {
      setError(result.message || "Sign in failed.");
      setStep('emailAuth'); 
    }
  };

  const handleGoogleStudentNameConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameForProfile.trim()) { setError("Name cannot be empty."); return; }
    if (pendingFirebaseProfileCreationUser) {
      setStep('processing');
      const result = await completeStudentProfileCreation(pendingFirebaseProfileCreationUser, nameForProfile);
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

    if (pendingFirebaseProfileCreationUser) {
      setStep('processing');
      const result = await completeShopOwnerProfileCreation(
        pendingFirebaseProfileCreationUser, 
        { shopName, shopAddress },
        nameForProfile 
      );
      handleProfileCreationResult(result, null, 'shopOwnerDetails');
    } else {
      setError("Authentication session lost. Please try signing in again.");
      handleCancelAndReset(false); 
    }
  };
  
  const handleRoleSelectedForPendingProfile = (userType: UserType) => {
    console.log(`[LoginPage/handleRoleSelectedForPendingProfile] Role selected: ${userType}. Storing to component state and session storage.`);
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
    console.log(`[LoginPage/handleCancelAndReset] Soft reset: ${softReset}`);
    setError(''); setMessage('');
    
    if (!softReset) { // Hard reset
        clearSessionStorageAuthFlow();
        if (pendingFirebaseProfileCreationUser) {
            console.log("[LoginPage/handleCancelAndReset] Hard reset: Signing out pending user.");
            setStep('processing'); 
            await signOut(auth); 
        }
        setIntendedUserTypeForSignup(null);
        setAuthMethodForSignup(null);
    } else {
        console.log("[LoginPage/handleCancelAndReset] Soft reset: Preserving component auth method and intended type. Session storage untouched here.");
    }

    // Common reset for both soft and hard, except for critical flow states on soft.
    setNameForProfile('');
    setEmail('');
    setPassword('');
    setShopName('');
    setShopAddress('');
    
    if(!softReset) {
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
          <span className="text-brand-text">EZY</span><span className="text-brand-primary">PRINT</span>
        </h1>
        <p className="text-sm text-brand-primaryDark font-semibold tracking-wider">PAY PRINT COLLECT</p>
      </div>

      <Card className="w-full max-w-md bg-brand-secondary/90 backdrop-blur-md">
        {error && <p className="mb-4 p-3 bg-status-error/20 text-status-error text-sm rounded-md text-center" role="alert">{error}</p>}
        {message && !error && <p className="mb-4 p-3 bg-status-info/20 text-status-info text-sm rounded-md text-center" role="status">{message}</p>}

        {step === 'processing' && (
            <div className="p-8 text-center">
                <Spinner size="lg" />
                <p className="mt-4 text-brand-lightText">Processing... Please wait.</p>
            </div>
        )}

        {step !== 'processing' && step !== 'shopOwnerDetails' && step !== 'confirmGoogleUserName' && step !== 'selectRoleForPendingProfile' && (
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
                <h2 className="text-xl font-semibold text-brand-text mb-2">Join EzyPrint with Google</h2>
                <Button onClick={() => handleGoogleSignIn(UserType.STUDENT)} variant="primary" size="lg" fullWidth leftIcon={<GoogleIcon />}>
                    Student with Google
                </Button>
                <Button onClick={() => handleGoogleSignIn(UserType.SHOP_OWNER)} variant="secondary" size="lg" fullWidth leftIcon={<GoogleIcon />}>
                    Shop Owner with Google
                </Button>
            </div>
        )}

        {step === 'emailAuth' && authMode === 'email' && (
            <div className="space-y-4 p-4 pt-6">
                <h2 className="text-xl font-semibold text-brand-text text-center mb-3">
                    {emailSubMode === 'signin' ? 'Sign In with Email' : 'Create New Account'}
                </h2>
                {emailSubMode === 'signup' && (
                    <Input label="Full Name" id="nameForProfile" type="text" value={nameForProfile} onChange={(e) => setNameForProfile(e.target.value)} placeholder="e.g. Alex Doe" required />
                )}
                <Input label="Email Address" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
                <Input label="Password" id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
                
                {emailSubMode === 'signin' ? (
                    <>
                        <Button onClick={handleEmailPasswordSignIn} variant="primary" size="lg" fullWidth className="mt-5" leftIcon={<MailIcon/>}>
                            Sign In
                        </Button>
                        <p className="text-center text-xs text-brand-muted my-3">
                            Don't have an account?{' '}
                            <button onClick={() => { setEmailSubMode('signup'); setError(''); }} className="font-semibold text-brand-primary hover:underline focus:outline-none">
                                Sign Up
                            </button>
                        </p>
                    </>
                ) : ( 
                    <>
                        <p className="text-center text-xs text-brand-muted my-1">SIGN UP AS:</p>
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
            <Button type="submit" variant="primary" size="lg" fullWidth>
              Register Shop & Login
            </Button>
             <Button type="button" variant="ghost" size="sm" onClick={() => handleCancelAndReset(false)} fullWidth>
              Back / Cancel
            </Button>
          </form>
        )}
      </Card>
      <p className="mt-8 text-xs text-brand-muted text-center max-w-md px-2">
        Your information is managed securely. By signing in or creating an account, you agree to our terms.
      </p>
    </div>
  );
};

export default LoginPage;
