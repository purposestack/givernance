import React from 'react';

interface ResultRow {
  id: string;
  rowNumber: number;
  status: string;
  rowData: any;
  errorCode?: string;
  errorMessage?: string;
}

export function BulkImportResults({ results }: { results: ResultRow[] }) {
  const [filter, setFilter] = React.useState('all');

  const filtered = filter === 'all' ? results : results.filter(r => r.status === filter);

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Import Results</h2>
      
      <div className="flex gap-2 mb-4">
        {['all', 'created', 'duplicate', 'failed'].map(tab => (
          <button 
            key={tab} 
            onClick={() => setFilter(tab)}
            className={`px-4 py-2 rounded ${filter === tab ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-gray-100">
            <th className="p-2 text-left">Row</th>
            <th className="p-2 text-left">Status</th>
            <th className="p-2 text-left">Data</th>
            <th className="p-2 text-left">Error</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(row => (
            <tr key={row.id} className="border-t">
              <td className="p-2">{row.rowNumber}</td>
              <td className="p-2">{row.status}</td>
              <td className="p-2 text-sm">{JSON.stringify(row.rowData)}</td>
              <td className="p-2 text-red-500">{row.errorMessage}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
