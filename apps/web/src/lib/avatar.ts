// 프로필 이미지가 없으므로 닉네임 첫 글자와 사용자 ID로 정한 색으로 원형 아바타를 그린다
const PALETTE = ['#00c98d', '#4f8cff', '#ff7a45', '#c264ff', '#ffb020', '#ff4d7d', '#2ec5d3', '#8bd346']

/** 아바타·썸네일에 그릴 첫 글자 */
export const initialOf = (name: string) => name.trim().charAt(0) || '?'

export const colorOf = (id: number) => PALETTE[Math.abs(id) % PALETTE.length]!
