// Faceted rendering of the Orizu origami swan (public/orizu-swan.svg):
// each polygon is filled with block/triangle glyphs and shrunk slightly so
// the seams between origami facets stay visible, matching the brand mark.
// Printed uncolored so it renders in the terminal's default foreground.
export const ORIZU_BANNER = `     ▄▄
   ▄▜▛ ██▙
  ▟▀   ◥██▛
        ▀▜▄
       ▄▟█
     ▄███
   ▄████◤        ▄▄▄█▛
 ▟█████◤     ▄▄█████▛
 ▄▀███◤  ▄█████████▛
 ◥█▄▀▛▐█▄◥▜███████▛ ███▀
  ▜██ ████▄◥▜████▛ ██▀
   █ ███████▄ ▜█▛ █▀
    ▐█████████◣  ▀`

export function renderBanner(): string {
  return ORIZU_BANNER
}
