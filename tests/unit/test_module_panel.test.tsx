import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModulePanelCard } from '../../electron/src/components/ModulePanel/ModulePanel';
import { ModulePanel } from '../../electron/src/api/client';

const samplePanel: ModulePanel = {
  panel_id: 'example:panel',
  module: 'example',
  title: 'Sample Panel',
  description: 'Demonstrates module panel rendering.',
  updated_at: 1,
  content: {
    sections: [
      {
        title: 'Status',
        items: [
          { label: 'Module', value: 'example' },
          { label: 'Version', value: '1.0' },
        ],
      },
    ],
    state: { project_keys: ['alpha'] },
  },
};

describe('ModulePanelCard', () => {
  it('renders panel metadata and sections', () => {
    render(<ModulePanelCard panel={samplePanel} />);

    expect(screen.getByText('Sample Panel')).toBeInTheDocument();
    expect(screen.getByText('Demonstrates module panel rendering.')).toBeInTheDocument();
    expect(screen.getByText('Module')).toBeInTheDocument();
    expect(screen.getByText('example')).toBeInTheDocument();
  });

  it('invokes refresh handler when provided', () => {
    const onRefresh = jest.fn();
    render(<ModulePanelCard panel={samplePanel} onRefresh={onRefresh} />);

    fireEvent.click(screen.getByText('Refresh'));
    expect(onRefresh).toHaveBeenCalledWith('example:panel');
  });
});
