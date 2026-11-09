// 프로필 이미지가 없으므로 닉네임 첫 글자와 사용자 ID로 정한 색으로 원형 아바타를 그린다
const PALETTE = ['#00c98d', '#4f8cff', '#ff7a45', '#c264ff', '#ffb020', '#ff4d7d', '#2ec5d3', '#8bd346']

export const colorOf = (id: number) => PALETTE[Math.abs(id) % PALETTE.length]!
