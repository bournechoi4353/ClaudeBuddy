// Each char = one pixel cell.
//   O = orange body
//   X = black (eye)
//   . = transparent
// Edit this grid to reshape the crab. No assets, no sprite sheets — just text.
const CRAB = [
  '..OOOOOOOO..',  // head top
  '..OXOOOOXO..',  // eyes
  '..OOOOOOOO..',  // head bottom
  'OOOOOOOOOOOO',  // arms top (full width — 2 cells out each side)
  'OOOOOOOOOOOO',  // arms bottom
  '..OOOOOOOO..',  // body
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..O.O..O.O..',  // 4 legs, equal width
  '..O.O..O.O..',
];

const COLORS = {
  O: '#CC785C', // Claude orange
  X: '#000000',
};

const SCALE = 7; // each pixel cell renders as a SCALE x SCALE square

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const cols = CRAB[0].length;
const rows = CRAB.length;
canvas.width = cols * SCALE;
canvas.height = rows * SCALE;

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const color = COLORS[CRAB[y][x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
}

draw();
