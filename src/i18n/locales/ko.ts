import type { LocalePack } from '../types';

/**
 * Korean.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const ko: LocalePack = {
    code: 'ko',
    label: '한국어',

    /**
     * Korean has no letter case, so `uppercase` on chrome labels does nothing,
     * and the wide letter-spacing the English chrome uses makes Hangul read as
     * broken. Both are cancelled here rather than in any component.
     */
    styleProfile: {
        caps: 'flat',
        tracking: 'tight',
    },

    strings: {
		
		// ── Header ───────────────────────────────────────────────────────────
    'header.drawer.open': 'Open context drawer',
    'header.drawer.close': 'Close context drawer',
    'header.title': '내러티브 엔진',
    'header.version.tooltip': '내러티브 엔진 버젼 {{version}}',
    'header.backup.tooltip': '백업 만들기',
    'header.backup.aria': '백업 만들기',
    'header.backup.label': '백업',
    'header.backup.toast.noChanges': '지난 백업 이후 변경 사항 없음',
    'header.backup.toast.created': '백업 생성 완료',
    'header.backup.toast.failed': '백업 생성 실패',
    'header.backups.tooltip': '백업 관리자',
    'header.backups.aria': '백업 관리자 열기',
    'header.backups.label': '백업 불러오기',
    'header.character.tooltip': '케릭터',
    'header.character.aria': '케릭터 패널 열기',
    'header.character.label': '케릭터',
    'header.npcLedger.tooltip': 'NPC 정보',
    'header.npcLedger.aria': 'NPC 정보 열기',
    'header.npcLedger.label': 'NPC 정보',
    'header.places.tooltip': '장소 정보',
    'header.places.aria': '장소 정보 열기',
    'header.places.label': '장소',
    'header.aiTier.tooltip': 'AI 티어: {{tier}} (Lite → Pro → Max중 선택)',
    'header.aiTier.aria': 'AI 티어: {{tier}}, 클릭으로 선택',
    'header.pinned.tooltip': '즐겨찾기 된 기억',
    'header.pinned.aria': '즐겨찾기 된 기억 열기',
    'header.pinned.label': '즐겨찾기',
    'header.settings.tooltip': '설정',
    'header.settings.aria': '설정 열기',
    'header.settings.label': '설정',
    'header.exit.tooltip': '캠페인 나가기',
    'header.exit.aria': '캠페인 나가기',
    'header.exit.label': '나가기',

    // ── Settings modal (shell) ───────────────────────────────────────────
    'settings.dialog.aria': '설정',
    'settings.title': '⚙ 설정',
    'settings.version.tooltip': '설치된 내러티브 엔진 버젼',
    'settings.close.aria': '설정 닫기',
    'settings.tab.providers': 'LLM 공급자',
    'settings.tab.presets': '프리셋',
    'settings.tab.global': '글로벌 설정',
    'settings.tab.advanced': '고급',
    'settings.tab.debug': '디버그',

    // ── Settings → Language ──────────────────────────────────────────────
    'settings.language.label': '인터페이스 언어',
    'settings.language.help': '메뉴와 버튼 언어만 바뀝니다. 아직 번역이 안된 부분은 영어로 표기됩니다.',
    'settings.language.contribute': '언어가 없나요? docs/TRANSLATING.md를 참고하세요. 다른 툴 필요 없이 파일 하나면 됩니다.',
    'settings.language.pseudoWarning': '레이아웃 테스트용 입니다 - 실제 언어가 아닙니다. 버튼 크기보다 더 큰 텍스트가 있는지 확인하는 용도입니다.',
    'settings.language.complete': '번역 완료.',
    // Plural reference example. English needs one/other; Russian additionally
    // needs few/many. Only `.other` is mandatory — a locale that defines just
    // `.other` still renders correctly. Call as: t('...untranslated', { count }).
    'settings.language.untranslated.one': '{{count}}개 단어가 아직도 영어로 표기되는 중입니다.',
    'settings.language.untranslated.other': '{{count}}개 단어가 아직도 영어로 표기되는 중입니다.',

    // ── Campaign hub ─────────────────────────────────────────────────────
    'hub.import.tooltip': '캠페인 불러오기',
    'hub.settings.tooltip': '설정',
    'hub.worldLore.tooltip': '세계관 만들기',
    'hub.tagline': 'AI 게임 마스터 시스템',
    'hub.brand.lead': '내러티브',
    'hub.brand.accent': '넥서스',
    'hub.subtitle': '세계를 선택하고, 운명을 만드세요.',
    'hub.delete.confirm': '이 캠페인을 지우시겠습니까? 채팅 내역, 세계관, 저장 파일이 영구적으로 삭제됩니다.',
    'hub.delete.cancel': '취소',
    'hub.delete.confirmAction': '삭제',
    'hub.export.failed': '불러오기 실패',
    'hub.import.success': '"{{name}}" 불러오기 성공 - 검색 인덱싱은 자동으로 돌아갑니다.',
    'hub.import.failed': '불러오기 실패. 올바른 캠페인 파일이 아닙니다.',
    },
};
