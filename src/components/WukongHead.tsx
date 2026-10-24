/** Same flat brand character as Webdesk, without its HTTP/session dependencies. */
export default function WukongHead({ active = true, busy = false, listening = false, expression = "normal" }: { active?: boolean; busy?: boolean; listening?: boolean; expression?: "normal" | "happy" | "sleepy" | "grumpy" | "bold" }) {
  return <svg className={`room-wukong ${active ? "is-awake" : ""} ${busy ? "is-thinking" : ""} ${listening ? "is-listening" : ""}`} viewBox="0 0 96 96" role="img" aria-label={`悟空${busy ? "正在思考" : listening ? "正在听你说" : "头像"}`}>
    <circle cx="15" cy="52" r="11" fill="#9c583b" /><circle cx="81" cy="52" r="11" fill="#9c583b" />
    <path d="M16 39Q18 13 48 13T80 39V62Q76 86 48 86T16 62Z" fill="#b5683e" />
    <path d="M26 37Q29 28 38 30L48 37L58 30Q67 28 70 37L74 57Q72 78 48 79Q24 78 22 57Z" fill="#f0c498" />
    <path d="M18 35Q48 19 78 35" fill="none" stroke="#eac06b" strokeWidth="8" strokeLinecap="round" />
    <path d="M40 28q-9-7-10 1q0 10 18 5q18 5 18-5q-1-8-10-1" fill="none" stroke="#69422f" strokeWidth="3" strokeLinecap="round" />
    <path d={expression === "grumpy" || expression === "bold" ? "m27 39 12 4m18 0 12-4" : "m27 42 12-3m18 0 12 3"} stroke="#4a302a" strokeWidth="3" strokeLinecap="round" />
    {expression === "sleepy" || expression === "grumpy" ? <g className="room-wukong__eyes" fill="none" stroke="#4a302a" strokeWidth="3" strokeLinecap="round"><path d={expression === "sleepy" ? "M27 52q7 6 14 0m14 0q7 6 14 0" : "m27 52 14 1m14 0 14-1"} /></g> : <g className="room-wukong__eyes"><ellipse cx="34" cy="51" rx="8" ry="7" fill="#fff7e9" /><ellipse cx="62" cy="51" rx="8" ry="7" fill="#fff7e9" /><g className="room-wukong__pupils"><circle cx="35" cy="52" r="4" fill="#262329" /><circle cx="61" cy="52" r="4" fill="#262329" /><circle cx="36" cy="50.5" r="1.3" fill="#fff" /><circle cx="62" cy="50.5" r="1.3" fill="#fff" /></g></g>}
    <path d="m44 61 4 3 4-3" fill="none" stroke="#ad7857" strokeWidth="2.5" strokeLinecap="round" />
    <path d={expression === "grumpy" ? "M40 72q8-5 16 0" : expression === "sleepy" ? "M44 70q4-3 8 0q2 6-4 6t-4-6" : expression === "bold" ? "M38 68q10 13 20 0Z" : "M38 70q10 6 20-1"} fill={expression === "bold" ? "#65442f" : "none"} stroke="#65442f" strokeWidth="2.5" strokeLinecap="round" />
  </svg>;
}
