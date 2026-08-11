import { useTheme } from '../hooks/useTheme';
import type { ThemeSetting } from '../hooks/useTheme';
import { IconButton } from './IconButton';
import { AutoThemeIcon, MoonIcon, SunIcon } from './Icons';

const NEXT_LABEL: Record<ThemeSetting, string> = {
  dark: 'Switch to light theme',
  light: 'Use the system theme',
  system: 'Switch to dark theme',
};

const CURRENT_LABEL: Record<ThemeSetting, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

/**
 * Cycles dark -> light -> system.
 *
 * The icon shows the setting that is *active*, and the accessible name says
 * what pressing it will do — which is the pair a screen-reader user needs,
 * and the pair a sighted user infers from the tooltip.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { setting, cycle } = useTheme();

  const icon =
    setting === 'dark' ? <MoonIcon /> : setting === 'light' ? <SunIcon /> : <AutoThemeIcon />;

  return (
    <IconButton
      className={className}
      label={NEXT_LABEL[setting]}
      title={`Theme: ${CURRENT_LABEL[setting]}. ${NEXT_LABEL[setting]}.`}
      icon={icon}
      onClick={cycle}
    />
  );
}
