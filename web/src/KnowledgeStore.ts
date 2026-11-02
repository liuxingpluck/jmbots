/**
 * 知识库数据（zustand）：目录、文档摘要，以及右栏正在看的那篇全文，整个网页只有这一份。
 * 组件只订阅自己要的那一块；load() 由 App 在打开页面时调用，openDocument() 由右栏在网址换了文档时调用。
 * 选中了哪个目录、哪篇文档不放这里，放在 ViewStore（以网址为准）。
 */
import * as zustand from 'zustand';
import * as api from './Api.ts';
import type { DocumentDetail, DocumentSummary, KnowledgeBase } from './Types.ts';


/** 一次取全文的结果。 */
export interface OpenedDocument {
  /** 这次取的是哪一篇；和网址里的不一致时，说明结果已经过时，不显示。 */
  documentId: number;
  /** 取到的全文；这篇不存在或取失败时为 null。 */
  detail: DocumentDetail | null;
  /** 取失败时给用户看的原因；成功时为 null。 */
  error: string | null;
}


/** 知识库数据和加载动作。 */
interface KnowledgeState {
  /** 全部目录；加载前是空数组。 */
  bases: KnowledgeBase[];
  /** 全部文档摘要；加载前是空数组。 */
  documents: DocumentSummary[];
  /** 是否正在加载。 */
  loading: boolean;
  /** 加载失败时给用户看的原因；没失败为 null。 */
  error: string | null;
  /** 最近一次要看的文档 ID；全文回来时和它不一致，就说明又换了文档，结果丢掉。还没看过时为 null。 */
  openingId: number | null;
  /** 最近一次取回的全文；还没取过时为 null。 */
  opened: OpenedDocument | null;
  /** 取目录和文档摘要，成功后整体替换；失败时只记下 error，不抛错。 */
  load: () => Promise<void>;
  /** 取一篇的全文，回来时还是这一篇才记进 opened；失败时记下原因，不抛错。 */
  openDocument: (documentId: number) => Promise<void>;
}


/** 知识库数据的 store；组件用 `useKnowledgeStore((state) => state.xxx)` 取一块。 */
export const useKnowledgeStore = zustand.create<KnowledgeState>()((set, get) => ({
  bases: [],
  documents: [],
  loading: false,
  error: null,
  openingId: null,
  opened: null,
  load: async () => {
    // m: 目录和文档一起取、一起换，不会出现半新半旧的数据。
    set({ loading: true, error: null });
    try {
      const [bases, documents] = await Promise.all([api.loadBases(), api.loadDocuments()]);
      set({ bases, documents, loading: false });
    } catch (error) {
      // g: 失败时保留原来的数据，只记下原因。
      set({ loading: false, error: error instanceof Error ? error.message : '未知错误' });
    }
  },
  openDocument: async (documentId) => {
    set({ openingId: documentId });
    /** 这次取的结果。 */
    let opened: OpenedDocument;
    try {
      opened = { documentId, detail: await api.loadDocument(documentId), error: null };
    } catch (error) {
      opened = { documentId, detail: null, error: error instanceof Error ? error.message : '未知错误' };
    }
    // g: 等待期间又换了文档，这次的结果已经过时，丢掉，免得显示错的文档。
    if (get().openingId !== documentId) {
      return;
    }
    set({ opened });
  },
}));
