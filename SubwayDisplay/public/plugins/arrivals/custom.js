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
    return `api/arrivals?station=${station}`;
  },

  formatData: function(response) {
    return response.data;
  }
};
