import React from 'react';

interface HistoryItem {
  id: string;
  status: string;
  totalRows: number;
  createdCount: number;
  duplicateCount: number;
  failedCount: number;
  createdAt: string;
}

export function BulkImportHistory({ jobs }: { jobs: HistoryItem[] }) {
  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Import History</h2>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100">
            <th className="p-2 text-left">Date</th>
            <th className="p-2 text-left">Status</th>
            <th className="p-2 text-left">Total</th>
            <th className="p-2 text-left">Created</th>
            <th className="p-2 text-left">Duplicates</th>
            <th className="p-2 text-left">Failed</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id} className="border-t">
              <td className="p-2">{new Date(job.createdAt).toLocaleDateString()}</td>
              <td className="p-2">{job.status}</td>
              <td className="p-2">{job.totalRows}</td>
              <td className="p-2">{job.createdCount}</td>
              <td className="p-2">{job.duplicateCount}</td>
              <td className="p-2">{job.failedCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
