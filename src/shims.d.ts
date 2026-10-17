declare module 'mammoth/mammoth.browser' {
  interface Message { type: string; message: string }
  interface Result { value: string; messages: Message[] }
  interface ImageElement { src: string; alt?: string }
  interface Image { contentType: string; read(encoding: 'base64'): Promise<string> }
  const mammoth: {
    convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<Result>;
    images: { imgElement(fn: (image: Image) => Promise<ImageElement>): unknown };
  };
  export default mammoth;
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export * from 'pdfjs-dist';
}
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
