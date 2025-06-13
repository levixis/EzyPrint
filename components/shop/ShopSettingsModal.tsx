
import React, { useState, useEffect, useRef } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { ShopProfile, ShopPricing, PayoutMethod, PayoutMethodType } from '../../types';
import { calculateBaseFee } from '../../contexts/AppContext';
import { Card } from '../common/Card';

interface ShopSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  shop: ShopProfile;
  onSaveSettings: (shopId: string, newSettings: { pricing: ShopPricing; isOpen: boolean; payoutMethods?: PayoutMethod[] }) => void;
}

const generatePayoutMethodId = () => `pm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

const EMPTY_PAYOUT_METHOD_FORM: Partial<PayoutMethod> & { type: PayoutMethodType } = {
  id: '',
  type: 'UPI',
  accountHolderName: '',
  accountNumber: '',
  ifscCode: '',
  bankName: '',
  upiId: '',
  isPrimary: false,
  nickname: '',
};

const ShopSettingsModal: React.FC<ShopSettingsModalProps> = ({ isOpen, onClose, shop, onSaveSettings }) => {
  const [bwPriceInput, setBwPriceInput] = useState(String(shop.customPricing.bwPerPage));
  const [colorPriceInput, setColorPriceInput] = useState(String(shop.customPricing.colorPerPage));
  const [isShopOpen, setIsShopOpen] = useState(shop.isOpen);

  const [currentPayoutMethods, setCurrentPayoutMethods] = useState<PayoutMethod[]>(shop.payoutMethods || []);
  const [editingPayoutMethod, setEditingPayoutMethod] = useState<Partial<PayoutMethod> & { type: PayoutMethodType } | null>(null);

  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const prevIsOpen = useRef(isOpen);
  const prevShopId = useRef(shop.id);


  useEffect(() => {
    if (isOpen) {
        if (!prevIsOpen.current || shop.id !== prevShopId.current) {
            setBwPriceInput(String(shop.customPricing.bwPerPage));
            setColorPriceInput(String(shop.customPricing.colorPerPage));
            setIsShopOpen(shop.isOpen);
            setCurrentPayoutMethods(shop.payoutMethods ? JSON.parse(JSON.stringify(shop.payoutMethods)) : []);
            setEditingPayoutMethod(null);
            setError('');
            setFormError('');
        }
    }
    prevIsOpen.current = isOpen;
    prevShopId.current = shop.id;
  }, [isOpen, shop]);


  const handleMainSave = () => {
    setError('');

    const parsedBwPrice = parseFloat(bwPriceInput);
    const parsedColorPrice = parseFloat(colorPriceInput);

    const finalBw = bwPriceInput.trim() === '' ? 0 : (isNaN(parsedBwPrice) ? -1 : parsedBwPrice);
    const finalColor = colorPriceInput.trim() === '' ? 0 : (isNaN(parsedColorPrice) ? -1 : parsedColorPrice);

    if (finalBw < 0 || finalColor < 0) {
      setError('Prices must be valid positive numbers. Please enter a number or leave blank for 0.');
      return;
    }

    if (finalBw === 0 && finalColor === 0) {
        setError('At least one price (B&W or Color) must be greater than zero.');
        return;
    }

    const cleanedPayoutMethods = currentPayoutMethods.map(pm => ({
        id: pm.id,
        type: pm.type,
        accountHolderName: pm.accountHolderName || '',
        accountNumber: pm.accountNumber || '',
        ifscCode: pm.ifscCode || '',
        bankName: pm.bankName || '',
        upiId: pm.upiId || '',
        isPrimary: pm.isPrimary || false,
        nickname: pm.nickname || '',
    }));

    const primaryMethodsCount = cleanedPayoutMethods.filter(pm => pm.isPrimary).length;
    if (cleanedPayoutMethods.length > 0 && primaryMethodsCount === 0) {
        setError("If you have payout methods, please mark one as primary.");
        return;
    }
    if (primaryMethodsCount > 1) {
        setError("Only one payout method can be marked as primary. Please correct.");
        return;
    }

    onSaveSettings(shop.id, {
        pricing: { bwPerPage: finalBw, colorPerPage: finalColor },
        isOpen: isShopOpen,
        payoutMethods: cleanedPayoutMethods
    });
    onClose();
  };

  const handleStartAddPayoutMethod = () => {
    setFormError('');
    setEditingPayoutMethod({ ...EMPTY_PAYOUT_METHOD_FORM, id: generatePayoutMethodId(), isPrimary: currentPayoutMethods.length === 0 });
  };

  const handleStartEditPayoutMethod = (method: PayoutMethod) => {
    setFormError('');
    // Ensure all optional string fields are initialized to '' if undefined in method
    // and boolean isPrimary defaults to false
    const formReadyMethod: Partial<PayoutMethod> & { type: PayoutMethodType } = {
        id: method.id, // id is required
        type: method.type, // type is required
        accountHolderName: method.accountHolderName || '',
        accountNumber: method.accountNumber || '',
        ifscCode: method.ifscCode || '',
        bankName: method.bankName || '',
        upiId: method.upiId || '',
        isPrimary: method.isPrimary || false,
        nickname: method.nickname || '',
    };
    setEditingPayoutMethod(formReadyMethod);
  };

  const handleCancelEditPayoutMethod = () => {
    setEditingPayoutMethod(null);
    setFormError('');
  };

  const handleSavePayoutMethod = () => {
    setFormError('');
    if (!editingPayoutMethod) return;

    const { id, type } = editingPayoutMethod;
    // Values from editingPayoutMethod will be strings (possibly empty) due to formReadyMethod initialization
    const nickname = (editingPayoutMethod.nickname || '').trim();
    const accountHolderName = (editingPayoutMethod.accountHolderName || '').trim();
    const accountNumber = (editingPayoutMethod.accountNumber || '').trim();
    const ifscCode = (editingPayoutMethod.ifscCode || '').trim();
    const bankName = (editingPayoutMethod.bankName || '').trim();
    const upiId = (editingPayoutMethod.upiId || '').trim();
    const isPrimary = !!editingPayoutMethod.isPrimary;


    if (!nickname) { setFormError("Nickname is required for the payout method."); return; }

    let finalAccountHolderName = accountHolderName;
    let finalAccountNumber = accountNumber;
    let finalIfscCode = ifscCode;
    let finalBankName = bankName;
    let finalUpiId = upiId;

    if (type === 'BANK_ACCOUNT') {
        if (!finalAccountHolderName || !finalAccountNumber || !finalIfscCode || !finalBankName) {
            setFormError('For Bank Account, all fields (Holder, Number, IFSC, Bank Name) are required.');
            return;
        }
        finalUpiId = '';
    } else if (type === 'UPI') {
        if (!finalUpiId) {
            setFormError('For UPI, UPI ID is required.');
            return;
        }
        finalAccountHolderName = ''; finalAccountNumber = ''; finalIfscCode = ''; finalBankName = '';
    }

    const savedMethodData: PayoutMethod = {
        id: id!, type, nickname, isPrimary,
        accountHolderName: finalAccountHolderName,
        accountNumber: finalAccountNumber,
        ifscCode: finalIfscCode,
        bankName: finalBankName,
        upiId: finalUpiId,
    };

    let newPayoutMethodsList = [...currentPayoutMethods];
    const existingIndex = newPayoutMethodsList.findIndex(pm => pm.id === savedMethodData.id);

    if (savedMethodData.isPrimary) {
        newPayoutMethodsList = newPayoutMethodsList.map(pm =>
            pm.id === savedMethodData.id ? pm : { ...pm, isPrimary: false }
        );
    }

    if (existingIndex > -1) {
        newPayoutMethodsList[existingIndex] = savedMethodData;
    } else {
        newPayoutMethodsList.push(savedMethodData);
    }

     // Ensure the primary flag is correctly set on the saved method in the list
     const finalUpdatedIndex = newPayoutMethodsList.findIndex(pm => pm.id === savedMethodData.id);
     if (finalUpdatedIndex !== -1 && savedMethodData.isPrimary) {
         newPayoutMethodsList[finalUpdatedIndex] = savedMethodData;
     }


    setCurrentPayoutMethods(newPayoutMethodsList);
    setEditingPayoutMethod(null);
  };

  const handleDeletePayoutMethod = (methodId: string) => {
    let newMethods = currentPayoutMethods.filter(pm => pm.id !== methodId);
    // If the deleted method was primary, and other methods exist, make the first one primary.
    const deletedMethodWasPrimary = currentPayoutMethods.find(pm => pm.id === methodId)?.isPrimary;
    if (deletedMethodWasPrimary && newMethods.length > 0) {
        if (!newMethods.some(pm => pm.isPrimary)) { // if no other primary exists
            newMethods[0] = { ...newMethods[0], isPrimary: true };
        }
    }
    setCurrentPayoutMethods(newMethods);
  };

  const handlePayoutFormChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (!editingPayoutMethod) return;
    const { name, value, type } = e.target;
    if (type === 'checkbox') {
        setEditingPayoutMethod({ ...editingPayoutMethod, [name]: (e.target as HTMLInputElement).checked });
    } else {
        setEditingPayoutMethod({ ...editingPayoutMethod, [name]: value });
    }
  };

  const baseFeeTiers = [
    { range: "\u20B90.01 - \u20B95.00", fee: calculateBaseFee(5) },
    { range: "\u20B95.01 - \u20B930.00", fee: calculateBaseFee(30) },
    { range: "\u20B930.01 - \u20B970.00", fee: calculateBaseFee(70) },
    { range: "Over \u20B970.00", fee: calculateBaseFee(71) },
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Settings for ${shop.name}`} size="2xl">
      <div className="space-y-6">
        {error && <p className="text-sm text-status-error bg-red-700/20 p-3 rounded-md mb-3 -mt-2" role="alert">{error}</p>}
        <div>
          <h4 className="text-lg font-semibold text-brand-primary mb-2">Shop Status</h4>
           <div className={`p-3 rounded-lg border flex items-center justify-between ${isShopOpen ? 'bg-status-success/10 border-status-success' : 'bg-status-error/10 border-status-error'}`}>
            <label htmlFor="shopOpenToggle" className={`text-sm font-medium ${isShopOpen ? 'text-status-success' : 'text-status-error'}`}>
              {isShopOpen ? 'Shop is OPEN for new orders' : 'Shop is CLOSED for new orders'}
            </label>
            <div className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                id="shopOpenToggle"
                className="sr-only peer"
                checked={isShopOpen}
                onChange={() => setIsShopOpen(!isShopOpen)}
              />
              <div className="w-11 h-6 bg-brand-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-brand-primary peer-focus:ring-offset-2 peer-focus:ring-offset-brand-secondary rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-brand-muted after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-primary"></div>
            </div>
          </div>
          <p className="text-xs text-brand-muted mt-1">Toggle this to control if students can place new orders at your shop.</p>
        </div>

        <div>
          <h4 className="text-lg font-semibold text-brand-primary mb-2">Custom Per-Page Print Pricing</h4>
          <p className="text-sm text-brand-lightText mb-3">Set your shop's rates for printing. Base fees are standard and cannot be changed by shops. Enter 0 or leave blank if a type is not offered (but at least one must be &ge; 0).</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Input
              label="Black & White (per page)"
              id="bwPrice"
              type="text"
              inputMode="decimal"
              value={bwPriceInput}
              onChange={(e) => setBwPriceInput(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="e.g., 1.00 or leave blank for 0"
              leftIcon={<span className="text-brand-muted">₹</span>}
            />
            <Input
              label="Color (per page)"
              id="colorPrice"
              type="text"
              inputMode="decimal"
              value={colorPriceInput}
              onChange={(e) => setColorPriceInput(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="e.g., 3.00 or leave blank for 0"
              leftIcon={<span className="text-brand-muted">₹</span>}
            />
          </div>
        </div>

        <div>
            <h4 className="text-lg font-semibold text-brand-primary mb-2">Payout Methods</h4>
            <p className="text-sm text-brand-lightText mb-3">Manage your bank accounts or UPI IDs for receiving payments. Mark one as primary.</p>

            {currentPayoutMethods.length > 0 && (
                <div className="space-y-3 mb-4">
                    {currentPayoutMethods.map(method => (
                        <Card key={method.id} className="bg-brand-secondaryLight/50 !p-3 border border-brand-muted/30" noPadding>
                           <div className="p-3">
                            <div className="flex justify-between items-start">
                                <div>
                                    <p className="font-semibold text-brand-text">{method.nickname} {method.isPrimary && <span className="text-xs text-status-success bg-status-success/20 px-1.5 py-0.5 rounded-full ml-1">Primary</span>}</p>
                                    <p className="text-xs text-brand-muted">
                                        {method.type === 'UPI' ? `UPI: ${method.upiId}` : `Bank: ${method.bankName} (...${(method.accountNumber || '').slice(-4)})`}
                                    </p>
                                </div>
                                <div className="space-x-2 flex-shrink-0">
                                    <Button variant="ghost" size="sm" onClick={() => handleStartEditPayoutMethod(method)} className="!px-2 !py-1">Edit</Button>
                                    <Button variant="danger" size="sm" onClick={() => handleDeletePayoutMethod(method.id)} className="!px-2 !py-1">Del</Button>
                                </div>
                            </div>
                           </div>
                        </Card>
                    ))}
                </div>
            )}
             {currentPayoutMethods.length === 0 && !editingPayoutMethod && (
                 <p className="text-brand-muted text-center py-3 border border-dashed border-brand-muted/50 rounded-lg">No payout methods added yet.</p>
             )}

            {!editingPayoutMethod ? (
                <Button onClick={handleStartAddPayoutMethod} variant="secondary" size="md" fullWidth>
                    Add New Payout Method
                </Button>
            ) : (
                <Card className="bg-brand-secondaryLight/70 p-4 mt-4 border-2 border-brand-primary/50" noPadding>
                  <div className="p-4 space-y-3">
                    <h5 className="text-md font-semibold text-brand-primary">{currentPayoutMethods.find(pm=>pm.id === editingPayoutMethod!.id) ? 'Edit Payout Method' : 'Add New Payout Method'}</h5>
                    {formError && <p className="text-sm text-status-error bg-red-700/20 p-2 rounded-md" role="alert">{formError}</p>}
                    <Input label="Nickname" name="nickname" type="text" value={editingPayoutMethod.nickname || ''} onChange={handlePayoutFormChange} placeholder="e.g., Main Business Account" required/>
                    <Select label="Type" name="type" value={editingPayoutMethod.type} onChange={handlePayoutFormChange}
                        options={[ { value: 'UPI', label: 'UPI' }, { value: 'BANK_ACCOUNT', label: 'Bank Account' }]}
                    />
                    {editingPayoutMethod.type === 'BANK_ACCOUNT' && (
                        <>
                            <Input label="Account Holder Name" name="accountHolderName" type="text" value={editingPayoutMethod.accountHolderName || ''} onChange={handlePayoutFormChange} placeholder="e.g. John Doe" />
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <Input label="Account Number" name="accountNumber" type="text" value={editingPayoutMethod.accountNumber || ''} onChange={handlePayoutFormChange} placeholder="e.g. 1234567890" />
                                <Input label="IFSC Code" name="ifscCode" type="text" value={editingPayoutMethod.ifscCode || ''} onChange={handlePayoutFormChange} placeholder="e.g. SBIN0001234" />
                            </div>
                            <Input label="Bank Name" name="bankName" type="text" value={editingPayoutMethod.bankName || ''} onChange={handlePayoutFormChange} placeholder="e.g. State Bank of India" />
                        </>
                    )}
                    {editingPayoutMethod.type === 'UPI' && (
                        <Input label="UPI ID" name="upiId" type="text" value={editingPayoutMethod.upiId || ''} onChange={handlePayoutFormChange} placeholder="e.g. yourname@upi" />
                    )}
                    <div className="flex items-center pt-2">
                        <input id="isPrimaryPayout" name="isPrimary" type="checkbox" checked={editingPayoutMethod.isPrimary || false} onChange={handlePayoutFormChange} className="h-4 w-4 text-brand-primary bg-brand-secondaryLight border-brand-muted rounded focus:ring-brand-primary focus:ring-offset-brand-secondary"/>
                        <label htmlFor="isPrimaryPayout" className="ml-2 block text-sm text-brand-lightText">Set as primary payout method</label>
                    </div>
                    <div className="flex justify-end space-x-2 pt-3">
                        <Button variant="ghost" onClick={handleCancelEditPayoutMethod}>Cancel</Button>
                        <Button variant="primary" onClick={handleSavePayoutMethod}>Save Method</Button>
                    </div>
                  </div>
                </Card>
            )}
        </div>

        <div>
            <h4 className="text-lg font-semibold text-brand-primary mb-2 mt-4">Standard Base Fee Structure</h4>
            <p className="text-sm text-brand-lightText mb-3">
                A tiered base fee is automatically added to each order based on the total cost of the printed pages (before base fee). This fee is fixed.
            </p>
            <ul className="list-disc list-inside text-sm text-brand-lightText space-y-1 bg-brand-secondaryLight/50 p-3 rounded-md border border-brand-muted/30">
                {baseFeeTiers.map(tier => (
                    <li key={tier.range}>For page costs in range <strong>{tier.range}</strong>, Base Fee = <strong>
                        {`₹${tier.fee.toFixed(2)}`}
                    </strong></li>
                ))}
            </ul>
        </div>

        <div className="pt-6 flex justify-end space-x-3 border-t border-brand-muted/20 mt-6">
          <Button onClick={onClose} variant="ghost">Cancel</Button>
          <Button onClick={handleMainSave} variant="primary">Save All Settings</Button>
        </div>
      </div>
    </Modal>
  );
};

export default ShopSettingsModal;
