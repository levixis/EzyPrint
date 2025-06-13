
import React from 'react';
import { Card } from '../common/Card';
import { Button } from '../common/Button'; // If you want a mailto button

const ContactPage: React.FC = () => {
  const supportEmail = "support@ezyprint.example.com"; // Replace with your actual support email
  const supportPhone = "+91-123-456-7890"; // Replace with your actual support phone

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      <Card title="Contact Us" className="bg-brand-secondary/80 backdrop-blur-sm">
        <div className="prose prose-sm sm:prose lg:prose-lg xl:prose-xl max-w-none text-brand-lightText space-y-6">
          <p>We're here to help! If you have any questions, issues, or feedback regarding the EzyPrint service, please don't hesitate to get in touch with us.</p>

          <div>
            <h3 className="text-lg font-semibold text-brand-primary mb-2">General Inquiries & Support</h3>
            <p>For all support requests, questions about your orders, or issues with the platform, please reach out to our support team.</p>
            <ul className="list-none pl-0 space-y-2 mt-2">
              <li className="flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-brand-primary" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z" />
                  <path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z" />
                </svg>
                <span>Email: <a href={`mailto:${supportEmail}`} className="text-brand-accent hover:underline">{supportEmail}</a></span>
              </li>
              <li className="flex items-center">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 mr-2 text-brand-primary" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
                </svg>
                <span>Phone: <a href={`tel:${supportPhone}`} className="text-brand-accent hover:underline">{supportPhone}</a> (Mon-Fri, 9 AM - 6 PM IST)</span>
              </li>
            </ul>
          </div>
          
          <div>
            <h3 className="text-lg font-semibold text-brand-primary mb-2">Operating Address (Placeholder)</h3>
            <p>EzyPrint Platform Services<br />
            [Your Company Name/Levixis]<br />
            [123 Tech Park, Innovation Drive]<br />
            [City, State, Pin Code]<br />
            [Country, e.g., India]</p>
          </div>

          <div>
            <h3 className="text-lg font-semibold text-brand-primary mb-2">Feedback</h3>
            <p>We value your feedback to improve EzyPrint. Please feel free to share your thoughts and suggestions with us at the support email address mentioned above.</p>
          </div>

          {/* 
            Future: Could add a contact form here.
            For now, direct email/phone is sufficient.
          */}
          <p className="italic text-brand-muted mt-8">Please replace placeholder contact details with your actual information.</p>
        </div>
      </Card>
    </div>
  );
};

export default ContactPage;
