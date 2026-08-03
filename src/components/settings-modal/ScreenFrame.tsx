/**
 * WO-P5-17 / WO-P5-18 isolated screen frame host.
 *
 * The frame has an opaque origin and receives only the four declared API
 * capabilities through a request/response postMessage channel. The host
 * authenticates every inbound message by both contentWindow identity and a
 * nonce minted for this mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ValidatedModTable } from '../../services/mods/modTypes';
import {
    isScreenApiRequest,
    isStructuredCloneSafe,
    MAX_INBOUND_MESSAGES,
    MIN_SCREEN_HEIGHT_PX,
    MAX_SCREEN_HEIGHT_PX,
    MAX_SCREEN_DOWNLOAD_CHARS,
    SCREEN_CAMPAIGN_RESOURCES,
    SCREEN_THEME,
    tableAcceptsValue,
    tableDefault,
    type ScreenTableReadResult,
} from '../../services/mods/screenApiTypes';
import type { ScreenFaultKind } from '../../services/mods/screenFaults';
import { SCREEN_SANDBOX_ATTRIBUTE, SCREEN_FRAME_CSP, buildScreenSrcDoc } from './screenFrameBuild';

export interface ScreenFrameProps {
    modId: string;
    screen: { id: string; file: string; label?: string; capabilities?: readonly string[] };
    source: string;
    tables?: readonly ValidatedModTable[];
    onTableRead?: (table: string) => ScreenTableReadResult | Promise<ScreenTableReadResult>;
    onTableWrite?: (table: string, value: unknown) => void | Promise<void>;
    onCampaignRead?: (resource: string) => unknown | Promise<unknown>;
    onDownload?: (filename: string, content: string) => void | Promise<void>;
    onFault?: (fault: { modId: string; screenId: string; kind: ScreenFaultKind; message: string }) => void;
}

const SCREEN_FAULT_KINDS: readonly ScreenFaultKind[] = ['load', 'threw', 'crashed', 'denied', 'flood', 'malformed'];

function isScreenFaultKind(value: unknown): value is ScreenFaultKind {
    return typeof value === 'string' && SCREEN_FAULT_KINDS.includes(value as ScreenFaultKind);
}

function mintScreenNonce(): string {
    const values = new Uint32Array(4);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        crypto.getRandomValues(values);
        return Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('');
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function ScreenFrame({
    modId,
    screen,
    source,
    tables = [],
    onTableRead,
    onTableWrite,
    onCampaignRead,
    onDownload,
    onFault,
}: ScreenFrameProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const nonceRef = useRef(mintScreenNonce());
    const inboundMessagesRef = useRef(0);
    const initSentRef = useRef(false);
    const faultedRef = useRef(false);
    const [faulted, setFaulted] = useState(false);
    const [height, setHeight] = useState(MIN_SCREEN_HEIGHT_PX);
    const onFaultRef = useRef(onFault);
    const srcdoc = useMemo(() => buildScreenSrcDoc(source, SCREEN_FRAME_CSP), [source]);

    useEffect(() => {
        onFaultRef.current = onFault;
    }, [onFault]);

    const reportFault = useCallback((kind: ScreenFaultKind, message: string) => {
        if (faultedRef.current) return;
        faultedRef.current = true;
        setFaulted(true);
        onFaultRef.current?.({ modId, screenId: screen.id, kind, message });
    }, [modId, screen.id]);

    const sendInit = useCallback(() => {
        const target = iframeRef.current?.contentWindow;
        if (!target || initSentRef.current || faultedRef.current) return;
        initSentRef.current = true;
        target.postMessage({
            __screenInit: true,
            nonce: nonceRef.current,
            theme: SCREEN_THEME,
        }, '*');
    }, []);

    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const frameWindow = iframe.contentWindow;

        const sendResponse = (target: Window, id: number, ok: boolean, result?: unknown, error?: string) => {
            const response = { __screenResponse: true, id, nonce: nonceRef.current, ok, result, error };
            try {
                target.postMessage(response, '*');
            } catch {
                reportFault('malformed', 'response was not structured-clone-safe');
            }
        };

        const handleRequest = async (event: MessageEvent, data: Record<string, unknown>) => {
            const target = event.source as Window | null;
            if (!target || typeof target.postMessage !== 'function') return;
            if (!isScreenApiRequest(data)) {
                reportFault('malformed', 'request envelope is malformed');
                return;
            }
            if (data.nonce !== nonceRef.current) {
                sendResponse(target, data.id, false, undefined, 'denied: invalid screen nonce');
                reportFault('denied', 'invalid screen nonce');
                return;
            }

            const table = data.table === undefined ? undefined : tables.find((candidate) => candidate.name === data.table);
            if (data.capability === 'table.read') {
                if (!table) {
                    sendResponse(target, data.id, false, undefined, `denied: table "${String(data.table)}" is not declared by this mod`);
                    reportFault('denied', `table "${String(data.table)}" is not declared by this mod`);
                    return;
                }
                try {
                    const raw = await onTableRead?.(table.name);
                    const result = raw === undefined ? tableDefault(table) : raw;
                    if (!isStructuredCloneSafe(result)) {
                        sendResponse(target, data.id, false, undefined, 'malformed: table data is not serializable');
                        reportFault('malformed', 'table data is not structured-clone-safe');
                        return;
                    }
                    sendResponse(target, data.id, true, result);
                } catch (error) {
                    sendResponse(target, data.id, false, undefined, `table.read failed: ${String(error)}`);
                }
                return;
            }

            if (data.capability === 'table.write') {
                if (!table) {
                    sendResponse(target, data.id, false, undefined, `denied: table "${String(data.table)}" is not declared by this mod`);
                    reportFault('denied', `table "${String(data.table)}" is not declared by this mod`);
                    return;
                }
                if (!tableAcceptsValue(table, data.value)) {
                    sendResponse(target, data.id, false, undefined, `malformed: table "${table.name}" expects a ${table.recordShape}`);
                    reportFault('malformed', `table "${table.name}" expects a ${table.recordShape}`);
                    return;
                }
                try {
                    await onTableWrite?.(table.name, data.value);
                    sendResponse(target, data.id, true, { written: true });
                } catch (error) {
                    sendResponse(target, data.id, false, undefined, `table.write failed: ${String(error)}`);
                }
                return;
            }

            if (data.capability === 'theme') {
                sendResponse(target, data.id, true, SCREEN_THEME);
                return;
            }

            if (data.capability === 'resize') {
                if (typeof data.height !== 'number' || !Number.isFinite(data.height)) {
                    sendResponse(target, data.id, false, undefined, 'malformed: resize requires a finite height');
                    reportFault('malformed', 'resize requires a finite height');
                    return;
                }
                const nextHeight = Math.min(MAX_SCREEN_HEIGHT_PX, Math.max(MIN_SCREEN_HEIGHT_PX, Math.round(data.height)));
                setHeight(nextHeight);
                sendResponse(target, data.id, true, { height: nextHeight });
                return;
            }

            if (data.capability === 'campaign.read') {
                const resource = typeof data.resource === 'string' ? data.resource : '';
                const required = `campaign:read:${resource}`;
                if (!SCREEN_CAMPAIGN_RESOURCES.includes(resource as typeof SCREEN_CAMPAIGN_RESOURCES[number])
                    || !screen.capabilities?.includes(required)) {
                    sendResponse(target, data.id, false, undefined, `denied: campaign resource "${resource}" was not declared`);
                    reportFault('denied', `campaign resource "${resource}" was not declared`);
                    return;
                }
                try {
                    const result = await onCampaignRead?.(resource);
                    if (!isStructuredCloneSafe(result)) {
                        sendResponse(target, data.id, false, undefined, 'malformed: campaign data is not serializable');
                        reportFault('malformed', 'campaign data is not structured-clone-safe');
                        return;
                    }
                    sendResponse(target, data.id, true, result);
                } catch (error) {
                    sendResponse(target, data.id, false, undefined, `campaign.read failed: ${String(error)}`);
                }
                return;
            }

            if (data.capability === 'file.download') {
                if (!screen.capabilities?.includes('file:download')) {
                    sendResponse(target, data.id, false, undefined, 'denied: file download was not declared');
                    reportFault('denied', 'file download was not declared');
                    return;
                }
                const filename = typeof data.filename === 'string' ? data.filename.trim() : '';
                const content = typeof data.content === 'string' ? data.content : '';
                if (!filename || filename.length > 128 || filename.includes('/') || filename.includes('\\')
                    || content.length > MAX_SCREEN_DOWNLOAD_CHARS) {
                    sendResponse(target, data.id, false, undefined, 'malformed: invalid download payload');
                    reportFault('malformed', 'invalid download payload');
                    return;
                }
                try {
                    await onDownload?.(filename, content);
                    sendResponse(target, data.id, true, { downloaded: true });
                } catch (error) {
                    sendResponse(target, data.id, false, undefined, `file.download failed: ${String(error)}`);
                }
                return;
            }

            sendResponse(target, data.id, false, undefined, `denied: unknown capability "${data.capability}"`);
            reportFault('denied', `unknown capability "${data.capability}"`);
        };

        function handleMessage(event: MessageEvent) {
            if (event.source !== frameWindow) return;
            inboundMessagesRef.current += 1;
            if (inboundMessagesRef.current > MAX_INBOUND_MESSAGES) {
                reportFault('flood', `inbound message cap ${MAX_INBOUND_MESSAGES} exceeded`);
                return;
            }
            const data = event.data;
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                reportFault('malformed', 'inbound message is not an object');
                return;
            }
            const record = data as Record<string, unknown>;
            if (record.__screenFault === true) {
                if (record.nonce !== nonceRef.current) return;
                reportFault(
                    isScreenFaultKind(record.kind) ? record.kind : 'malformed',
                    typeof record.message === 'string' ? record.message : 'screen fault had no message',
                );
                return;
            }
            void handleRequest(event, record);
        }

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onCampaignRead, onDownload, onTableRead, onTableWrite, reportFault, screen.capabilities, tables]);

    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const onError = () => reportFault('load', `screen "${screen.id}" failed to load`);
        iframe.addEventListener('error', onError);
        return () => iframe.removeEventListener('error', onError);
    }, [reportFault, screen.id]);

    if (faulted) {
        return (
            <div
                data-screen-frame={modId}
                data-screen-id={screen.id}
                data-screen-faulted="true"
                className="bg-void p-3 border border-danger/40 rounded"
            >
                <div className="text-[11px] font-mono font-bold text-text-primary break-all">
                    {modId} · {screen.id}
                </div>
                <p className="text-[9px] text-danger leading-tight mt-1">
                    This screen faulted and was stopped. The app is unaffected.
                </p>
            </div>
        );
    }

    return (
        <iframe
            ref={iframeRef}
            title={`${modId}.${screen.id}`}
            srcDoc={srcdoc}
            sandbox={SCREEN_SANDBOX_ATTRIBUTE}
            onLoad={sendInit}
            data-screen-frame={modId}
            data-screen-id={screen.id}
            className="w-full bg-void border border-border rounded"
            style={{ height: `${height}px`, minHeight: `${MIN_SCREEN_HEIGHT_PX}px` }}
        />
    );
}
