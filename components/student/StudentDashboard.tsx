
import React from 'react';
import FileUploadForm from './FileUploadForm';
import StudentOrderList from './StudentOrderList';
import { useAppContext } from '../../contexts/AppContext';
import { Card } from '../common/Card';

interface StudentDashboardProps {
  userId: string;
  onNavigateToPass: () => void;
}

const StudentDashboard: React.FC<StudentDashboardProps> = ({ userId, onNavigateToPass }) => {
  const { getOrdersForCurrentUser, currentUser, isLoadingShops } = useAppContext();
  const studentOrders = getOrdersForCurrentUser(); // This now filters correctly for the student

  return (
    <div className="space-y-8 pt-28">
      <h2 className="text-3xl font-bold text-brand-text mb-6">Welcome, {currentUser?.name || 'Student'}!</h2>
      <Card title="Upload New Document" className="bg-brand-secondary/80 backdrop-blur-sm">
        <FileUploadForm userId={userId} isLoadingShops={isLoadingShops} onNavigateToPass={onNavigateToPass} />
      </Card>

      <Card title="My Print Orders" className="bg-brand-secondary/80 backdrop-blur-sm">
        {studentOrders.length > 0 ? (
          <StudentOrderList orders={studentOrders} /> // orders are already filtered for this student
        ) : (
          <p className="text-brand-lightText text-center py-4">You haven't placed any orders yet. Start by uploading a document!</p>
        )}
      </Card>
    </div>
  );
};

export default StudentDashboard;
