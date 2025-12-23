sf.display.ImageDrum = function() {
  return [
    ' ','0',
    '1', '2', '3', '4', '5', '6', '6X', '7', '7X',
    'A', 'B', 'C', 'D', 'E', 'F', 'FX', 'G', 'H', 'J',
    'L', 'M', 'N', 'Q', 'R', 'GS', 'FS', 'T',
    'V', 'W', 'Z', 'SI'
  ];
};

sf.plugins.arrivals = {
  dataType: 'json',

  url: function(options) {
    const station = window.selectedStation || 'R20';
    return `/api/stations/${station}/arrivals?max=14`;
  },

  formatData: function(response) {
    // Map API fields to split-flap fields
    return response.data.map(entry => ({
      line: entry.line,                                      // Route line (e.g., "1", "A", "7X")
      terminal: entry.terminal,                              // Destination (e.g., "South Ferry")
      scheduled: entry.scheduled,                            // ETA in minutes
      remarks: entry.status,                                 // Status text (e.g., "Delays", "Good Service")
      status: entry.status === 'Good Service' ? 'A' : 'B'   // Status light: A=green, B=red
    }));
  }
};
