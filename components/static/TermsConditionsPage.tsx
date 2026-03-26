

import React, { useEffect } from 'react';
import { Card } from '../common/Card';

const TermsConditionsPage: React.FC = () => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="max-w-3xl mx-auto pt-24 pb-8 px-4">
      <Card title="Terms and Conditions" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-4">
          <p><strong>Last Updated: {new Date().toLocaleDateString()}</strong></p>

          <h2 className="text-brand-primary">1. Acceptance of Terms</h2>
          <p>By accessing or using the EzyPrint application ("Service"), you agree to be bound by these Terms and Conditions ("Terms"). If you disagree with any part of the terms, then you may not access the Service.</p>

          <h2 className="text-brand-primary">2. Service Description</h2>
          <p>EzyPrint provides a platform for students to upload documents for printing services offered by registered print shops, make payments, and track orders. Shop owners can manage their print jobs and shop settings.</p>

          <h2 className="text-brand-primary">3. User Accounts</h2>
          <p>You must register for an account to use certain features. You are responsible for maintaining the confidentiality of your account password and for all activities that occur under your account. You agree to notify us immediately of any unauthorized use of your account.</p>

          <h2 className="text-brand-primary">4. User Responsibilities</h2>
          <ul>
            <li>You are solely responsible for the content of the documents you upload. You agree not to upload any material that is illegal, infringes on intellectual property rights, or is otherwise objectionable.</li>
            <li>Students are responsible for ensuring the accuracy of their print options and order details before payment.</li>
            <li>Shop owners are responsible for fulfilling orders accurately and in a timely manner, maintaining their shop information (including pricing and payout details), and adhering to service quality standards.</li>
          </ul>

          <h2 className="text-brand-primary">5. Payments and Fees</h2>
          <ul>
            <li>Students agree to pay the total price displayed for their orders, which includes the shop's page cost and EzyPrint's base fee.</li>
            <li>Payments are processed through Razorpay. EzyPrint is not responsible for any issues arising from the payment gateway.</li>
            <li>EzyPrint will facilitate payouts to shop owners based on the agreed terms, minus the applicable base fees. Shop owners are responsible for providing accurate payout information.</li>
          </ul>

          <h2 className="text-brand-primary">6. Intellectual Property</h2>
          <p>The Service and its original content, features, and functionality are and will remain the exclusive property of EzyPrint and its licensors. Uploaded documents remain the intellectual property of their respective owners.</p>

          <h2 className="text-brand-primary">7. Limitation of Liability</h2>
          <p>In no event shall EzyPrint, nor its directors, employees, partners, agents, suppliers, or affiliates, be liable for any indirect, incidental, special, consequential or punitive damages, including without limitation, loss of profits, data, use, goodwill, or other intangible losses, resulting from your access to or use of or inability to access or use the Service.</p>

          <h2 className="text-brand-primary">8. Disclaimer</h2>
          <p>Your use of the Service is at your sole risk. The Service is provided on an "AS IS" and "AS AVAILABLE" basis. The Service is provided without warranties of any kind, whether express or implied.</p>

          <h2 className="text-brand-primary">9. Governing Law</h2>
          <p>These Terms shall be governed and construed in accordance with the laws of [Your Jurisdiction, e.g., India], without regard to its conflict of law provisions.</p>

          <h2 className="text-brand-primary">10. Changes to Terms</h2>
          <p>We reserve the right, at our sole discretion, to modify or replace these Terms at any time. We will provide notice of any changes by posting the new Terms on this page.</p>

          <h2 className="text-brand-primary">11. Contact Us</h2>
          <p>If you have any questions about these Terms, please contact us via the "Contact Us" page or at [Your Support Email Address].</p>

        </div>
      </Card>
    </div>
  );
};

export default TermsConditionsPage;
