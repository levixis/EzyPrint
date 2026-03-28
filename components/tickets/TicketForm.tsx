import React, { useState, useRef } from 'react';
import { useAppContext } from '../../contexts/AppContext';
import { TicketCategory } from '../../types';
import { Button } from '../common/Button';
import { Input } from '../common/Input';
import { Select } from '../common/Select';
import { Modal } from '../common/Modal';

interface TicketFormProps {
  isOpen: boolean;
  onClose: () => void;
  prefilledOrderId?: string;
}

const CATEGORY_OPTIONS = [
  { value: TicketCategory.ORDER_ISSUE, label: 'Order Issue' },
  { value: TicketCategory.PAYMENT_ISSUE, label: 'Payment Issue' },
  { value: TicketCategory.DELIVERY_ISSUE, label: 'Delivery Issue' },
  { value: TicketCategory.OTHER, label: 'Other' },
];

const TicketForm: React.FC<TicketFormProps> = ({ isOpen, onClose, prefilledOrderId }) => {
  const { createTicket, orders } = useAppContext();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<TicketCategory>(prefilledOrderId ? TicketCategory.ORDER_ISSUE : TicketCategory.OTHER);
  const [description, setDescription] = useState('');
  const [relatedOrderId, setRelatedOrderId] = useState(prefilledOrderId || '');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const userOrders = orders;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const validFiles = files.filter(f => f.size <= 5 * 1024 * 1024).slice(0, 3 - attachments.length);
    if (files.some(f => f.size > 5 * 1024 * 1024)) {
      setError('Some files were too large (max 5MB each).');
    }
    setAttachments(prev => [...prev, ...validFiles].slice(0, 3));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!subject.trim()) { setError('Subject is required.'); return; }
    if (!description.trim()) { setError('Description is required.'); return; }

    setIsSubmitting(true);
    const result = await createTicket({
      subject: subject.trim(),
      category,
      description: description.trim(),
      relatedOrderId: relatedOrderId || undefined,
      attachmentFiles: attachments.length > 0 ? attachments : undefined,
    });

    setIsSubmitting(false);
    if (result.success) {
      setSubject('');
      setDescription('');
      setRelatedOrderId('');
      setAttachments([]);
      onClose();
    } else {
      setError(result.message || 'Failed to create ticket.');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Raise a Support Ticket" size="lg">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <p className="text-sm text-status-error bg-red-700/20 p-3 rounded-lg">{error}</p>}

        <Input
          label="Subject"
          id="ticketSubject"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Brief summary of your issue"
          required
        />

        <Select
          label="Category"
          name="ticketCategory"
          value={category}
          onChange={(e) => setCategory(e.target.value as TicketCategory)}
          options={CATEGORY_OPTIONS}
        />

        {userOrders.length > 0 && (
          <Select
            label="Related Order (optional)"
            name="relatedOrder"
            value={relatedOrderId}
            onChange={(e) => setRelatedOrderId(e.target.value)}
            options={[
              { value: '', label: 'None' },
              ...userOrders.slice(0, 20).map(o => ({
                value: o.id,
                label: `#${o.id.slice(-6)} — ${o.fileName} (₹${o.priceDetails.totalPrice.toFixed(2)})`,
              })),
            ]}
          />
        )}

        <div>
          <label className="block text-sm font-semibold text-brand-text dark:text-brand-dark-text mb-1">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 2000))}
            placeholder="Describe your issue in detail..."
            rows={5}
            className="w-full px-4 py-3 rounded-xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-primary focus:border-transparent transition-all resize-none text-sm"
            required
          />
          <p className="text-xs text-brand-lightText text-right mt-1">{description.length}/2000</p>
        </div>

        {/* Attachments */}
        <div>
          <label className="block text-sm font-semibold text-brand-text dark:text-brand-dark-text mb-1">
            Attachments <span className="text-xs font-normal text-brand-lightText">(max 3 files, 5MB each)</span>
          </label>
          {attachments.map((file, i) => (
            <div key={i} className="flex items-center justify-between bg-gray-50 dark:bg-zinc-800 px-3 py-2 rounded-lg mb-2 text-sm">
              <span className="truncate text-gray-700 dark:text-gray-300">{file.name} ({(file.size / 1024).toFixed(0)} KB)</span>
              <button type="button" onClick={() => removeAttachment(i)} className="text-red-500 hover:text-red-700 ml-2">✕</button>
            </div>
          ))}
          {attachments.length < 3 && (
            <>
              <input ref={fileInputRef} type="file" onChange={handleFileChange} className="hidden" multiple accept="image/*,.pdf,.txt,.doc,.docx" />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full py-2.5 border-2 border-dashed border-gray-300 dark:border-zinc-600 rounded-xl text-sm text-gray-500 dark:text-gray-400 hover:border-brand-primary hover:text-brand-primary transition-colors"
              >
                + Add File
              </button>
            </>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={isSubmitting}>
            {isSubmitting ? 'Submitting...' : 'Submit Ticket'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default TicketForm;
