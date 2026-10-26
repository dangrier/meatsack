declare module 'qrcode-svg' {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
    join?: boolean;
    predefined?: boolean;
    pretty?: boolean;
    swap?: boolean;
    xmlDeclaration?: boolean;
    container?: string;
  }

  export default class QRCode {
    constructor(options: QRCodeOptions | string);
    svg(options?: { container?: string }): string;
  }
}
