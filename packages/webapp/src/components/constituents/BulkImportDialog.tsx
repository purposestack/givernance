import React, { useState } from 'react';
import { api } from '../../lib/api'; // Assuming API client exists

interface BulkImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function BulkImportDialog({ open, onClose }: BulkImportDialogProps) {
  const [step, setStep] = useState(1); // 1: Template, 2: Upload, 3: Progress
  const [file, setFile] = useState<File | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleDownloadTemplate = async () => {
    const res = await api.get('/v1/constituents/bulk-import/template');
    const blob = new Blob([res.data], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'givernance-import-template.csv';
    a.click();
  };

  const handleUpload = async () => {
    if (!file) return;
    setError(null);
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const res = await api.post('/v1/constituents/bulk-import', formData);
      setJobId(res.data.data.jobId);
      setStep(3);
      pollStatus(res.data.data.jobId);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Upload failed');
    }
  };

  const pollStatus = async (id: string) => {
    const interval = setInterval(async () => {
      const res = await api.get(`/v1/constituents/bulk-import/${id}`);
      setProgress(res.data.data);
      if (['completed', 'partial', 'failed'].includes(res.data.data.status)) {
        clearInterval(interval);
      }
    }, 2000);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg max-w-lg w-full">
        <h2 className="text-xl font-bold mb-4">Bulk Import Constituents</h2>
        
        {step === 1 && (
          <div>
            <p>Download the template CSV file and fill it with your constituent data.</p>
            <button onClick={handleDownloadTemplate} className="btn btn-primary mt-4">
              Download Template
            </button>
            <p className="text-sm text-gray-500 mt-2">Includes 10 example rows.</p>
          </div>
        )}

        {step === 2 && (
          <div>
            <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setFile(e.target.files?.[0] || null)} />
            {error && <p className="text-red-500">{error}</p>}
            <button onClick={handleUpload} disabled={!file} className="btn btn-primary mt-4">
              Start Import
            </button>
          </div>
        )}

        {step === 3 && progress && (
          <div>
            <h3>Status: {progress.status}</h3>
            <p>Processed: {progress.processedRows} / {progress.totalRows}</p>
            <div className="flex gap-4 mt-2">
              <span>Created: {progress.createdCount}</span>
              <span>Duplicates: {progress.duplicateCount}</span>
              <span>Failed: {progress.failedCount}</span>
            </div>
            <div className="flex gap-4 mt-2">
              <span>Complete Address: {progress.completeAddressCount || 0}</span>
              <span>With Email: {progress.emailCount || 0}</span>
            </div>
          </div>
        )}

        <button onClick={onClose} className="btn btn-secondary mt-4">Close</button>
      </div>
    </div>
  );
}
