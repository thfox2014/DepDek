case $- in
  *i*) ;;
  *) return ;;
esac

if [ ! -t 0 ] || [ "${TERM:-dumb}" = dumb ] || [ -n "${DISPLAY:-}" ]; then
  return
fi

printf '\n\033[38;5;208m  JIAHO AI-OS\033[0m  \033[38;5;244mAI, at home.\033[0m\n'
printf '\033[38;5;240m  ───────────────────────────────────────────────────────────\033[0m\n'
printf '  \033[1mjiaho\033[0m          Open your Jiaho home system\n'
printf '  \033[38;5;244mdepdek-shell\033[0m     Compatibility alias for jiaho\n'
printf '  \033[38;5;244mhelp\033[0m             Browse available system commands\n'
printf '  \033[38;5;240mOpen the visual shell to sign in to your private space.\033[0m\n\n'
