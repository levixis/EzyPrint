
import React from 'react';
import { Card } from '../common/Card';

const PrivacyPolicyPage: React.FC = () => {
  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <Card title="Privacy Policy" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-4">
          <p><strong>Last Updated: {new Date().toLocaleDateString()}</strong></p>
          
          <h2 className="text-brand-primary">1. Introduction</h2>
          <p>Welcome to EzyPrint ("we," "our," or "us"). We are committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our application.</p>

          <h2 className="text-brand-primary">2. Information We Collect</h2>
          <p>We may collect personal information such as:</p>
          <ul>
            <li>Name, email address, user type (Student/Shop Owner).</li>
            <li>Uploaded documents for printing (we process these for printing and do not store them longer than necessary for order fulfillment).</li>
            <li>Order details, including print options, shop selected, and transaction information (via Razorpay, we do not store full payment card details).</li>
            <li>Shop details provided by Shop Owners, including shop name, address, pricing, and payout information.</li>
            <li>Usage data, IP address, browser type (collected automatically).</li>
          </ul>

          <h2 className="text-brand-primary">3. How We Use Your Information</h2>
          <p>We use the information we collect to:</p>
          <ul>
            <li>Provide, operate, and maintain our services.</li>
            <li>Process your print orders and facilitate payments.</li>
            <li>Manage your account and provide customer support.</li>
            <li>Communicate with you about your orders or important updates.</li>
            <li>Enable shop owners to manage their services and receive payouts.</li>
            <li>Improve our application and user experience.</li>
            <li>Comply with legal obligations.</li>
          </ul>

          <h2 className="text-brand-primary">4. Sharing Your Information</h2>
          <p>We may share your information with:</p>
          <ul>
            <li>Selected print shops to fulfill your orders.</li>
            <li>Payment processors (e.g., Razorpay) to facilitate payments.</li>
            <li>Service providers who assist us in operating our application.</li>
            <li>Legal authorities if required by law.</li>
          </ul>
          <p>We do not sell your personal information to third parties.</p>

          <h2 className="text-brand-primary">5. Data Security</h2>
          <p>We implement reasonable security measures to protect your information. However, no electronic transmission or storage is 100% secure.</p>
          <p>Shop payout information (bank/UPI details) is collected for processing payouts and should be handled with utmost care. While this demo uses local storage, a production system would require robust, encrypted database storage and secure access controls.</p>

          <h2 className="text-brand-primary">6. Your Data Rights</h2>
          <p>You may have rights to access, correct, or delete your personal information, subject to applicable laws. Please contact us to make such requests.</p>
          
          <h2 className="text-brand-primary">7. Cookies and Tracking Technologies</h2>
          <p>We may use cookies and similar tracking technologies to enhance your experience. You can control cookie preferences through your browser settings.</p>

          <h2 className="text-brand-primary">8. Changes to This Policy</h2>
          <p>We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new policy on this page.</p>

          <h2 className="text-brand-primary">9. Contact Us</h2>
          <p>If you have any questions about this Privacy Policy, please contact us through the "Contact Us" page or at [Your Support Email Address].</p>
          <p className="italic text-brand-muted">This is a template. Please replace with your own comprehensive Privacy Policy reviewed by a legal professional.</p>
        </div>
      </Card>
    </div>
  );
};

export default PrivacyPolicyPage;
