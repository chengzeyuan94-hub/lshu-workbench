import type { ReactNode } from 'react';

interface IconProps {
  size?: number;
}

const stroke = {
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'square' as const,
  strokeLinejoin: 'miter' as const,
  fill: 'none',
};

function Svg({ size = 24, children }: IconProps & { children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      {children}
    </svg>
  );
}

export const IconHome = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 12 L12 4 L20 12" />
    <path d="M6 11 V20 H18 V11" />
    <path d="M10 20 V15 H14 V20" />
  </Svg>
);

export const IconTodo = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <rect x="4" y="4" width="16" height="16" />
    <path d="M8 12 L11 15 L16 9" />
  </Svg>
);

export const IconChart = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 20 V6" />
    <path d="M4 20 H20" />
    <path d="M8 16 V12" />
    <path d="M12 16 V8" />
    <path d="M16 16 V10" />
  </Svg>
);

export const IconScan = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 8 V4 H8" />
    <path d="M16 4 H20 V8" />
    <path d="M20 16 V20 H16" />
    <path d="M8 20 H4 V16" />
    <rect x="9" y="9" width="6" height="6" />
  </Svg>
);

export const IconSettings = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <rect x="9" y="9" width="6" height="6" />
    <path d="M12 3 V7" />
    <path d="M12 17 V21" />
    <path d="M3 12 H7" />
    <path d="M17 12 H21" />
    <path d="M5 5 L8 8" />
    <path d="M16 16 L19 19" />
    <path d="M19 5 L16 8" />
    <path d="M8 16 L5 19" />
  </Svg>
);

export const IconHotspot = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 4 L16 12 H8 Z" />
    <path d="M8 14 H16 V20 H8 Z" />
  </Svg>
);

export const IconBrain = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <rect x="7" y="5" width="10" height="14" />
    <path d="M7 9 H4 V15 H7" />
    <path d="M17 9 H20 V15 H17" />
    <path d="M10 9 H14" />
    <path d="M10 13 H14" />
  </Svg>
);

export const IconScanBtn = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <rect x="5" y="5" width="10" height="10" />
    <path d="M17 17 L21 21" />
    <path d="M10 8 V12" />
    <path d="M8 10 H12" />
  </Svg>
);

export const IconRefresh = ({ size = 24 }: IconProps) => (
  <Svg size={size}>
    <path d="M20 12 A8 8 0 1 1 18 6" />
    <path d="M20 4 V8 H16" />
  </Svg>
);

export const IconArrowUp = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 19 V5" />
    <path d="M6 11 L12 5 L18 11" />
  </Svg>
);

export const IconArrowDown = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5 V19" />
    <path d="M6 13 L12 19 L18 13" />
  </Svg>
);

export const IconEye = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M3 12 L12 6 L21 12 L12 18 Z" />
    <rect x="10" y="10" width="4" height="4" />
  </Svg>
);

export const IconHeart = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 20 L4 12 L8 6 H11 L12 8 L13 6 H16 L20 12 Z" />
  </Svg>
);

export const IconStar = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 3 L14 10 H21 L16 14 L18 21 L12 17 L6 21 L8 14 L3 10 H10 Z" />
  </Svg>
);

export const IconComment = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M4 5 H20 V16 H8 L4 20 Z" />
    <path d="M8 9 H16" />
    <path d="M8 12 H13" />
  </Svg>
);

export const IconShare = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="15" y="3" width="5" height="5" />
    <rect x="3" y="10" width="5" height="5" />
    <rect x="15" y="16" width="5" height="5" />
    <path d="M8 12 L15 6" />
    <path d="M8 13 L15 18" />
  </Svg>
);

export const IconUserPlus = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <rect x="6" y="4" width="6" height="6" />
    <path d="M4 20 V16 H14 V20" />
    <path d="M18 8 V14" />
    <path d="M15 11 H21" />
  </Svg>
);

export const IconCheck = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M5 12 L10 17 L19 7" />
  </Svg>
);

export const IconAlert = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M12 4 L21 20 H3 Z" />
    <path d="M12 10 V14" />
    <path d="M12 17 V18" />
  </Svg>
);

export const IconClose = ({ size = 16 }: IconProps) => (
  <Svg size={size}>
    <path d="M6 6 L18 18" />
    <path d="M18 6 L6 18" />
  </Svg>
);
