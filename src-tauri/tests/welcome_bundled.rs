//! Opt-in end-to-end check against the actual bundled local model, not a mock.
#![cfg(unix)]

use agent_workbench_lib::{
    secrets::SecretText,
    vault::{WelcomePreferences, WelcomeVault},
};

#[test]
#[ignore = "requires the bundled llama-server on 127.0.0.1:11435"]
fn real_setup_reply_and_once_only_credit_grant() {
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary
        .path()
        .canonicalize()
        .unwrap()
        .join(".jiaho-onboarding");
    let store = WelcomeVault::open(&path).unwrap();
    assert!(
        WelcomeVault::model_ready(),
        "real bundled model must be ready"
    );
    assert_eq!(
        store
            .register(
                "smoke_home".into(),
                SecretText::new("SyntheticSmokeOnly2026!".into())
            )
            .unwrap()["balance"],
        1000
    );
    let operation = "bundled-real-smoke-001".to_string();
    let prompt = "第一次使用家合，我想整理家庭资料，请给三个简短的初始配置建议。".to_string();
    let result = store.chat(operation.clone(), prompt.clone()).unwrap();
    assert_eq!(result["balance"], 990);
    assert_eq!(result["local"], true);
    assert_eq!(result["model"], "jiaho-setup");
    let reply = result["reply"].as_str().unwrap();
    assert!(!reply.trim().is_empty());
    println!("Actual bundled model reply: {reply}");
    assert_eq!(store.chat(operation, prompt).unwrap()["reply"], reply);
    store
        .complete(WelcomePreferences {
            display_name: "Smoke home".into(),
            language: "zh-CN".into(),
            purpose: "family".into(),
        })
        .unwrap();
    store.logout().unwrap();
    drop(store);
    let reopened = WelcomeVault::open(&path).unwrap();
    assert_eq!(reopened.status().unwrap()["authenticated"], false);
    let signed_in = reopened
        .login(
            "smoke_home".into(),
            SecretText::new("SyntheticSmokeOnly2026!".into()),
        )
        .unwrap();
    assert_eq!(signed_in["balance"], 990);
    assert_eq!(signed_in["configured"], true);
    assert_eq!(signed_in["preferences"]["display_name"], "Smoke home");
}
