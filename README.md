# Run
- $ npx playwright test


# Allure Reporting
## Install on System:
- For Mac: $ brew install allure
- For Ubuntu: $ npm install -g allure-commandline

## Install
- $ npm i -D allure-playwright

## Run
- $ allure generate --clean
- $ allure serve


## Allure API
- https://github.com/allure-framework/allure-js/tree/main/packages/allure-playwright
- In spec:
    import * as allure from "allure-js-commons";
    await allure.severity("critical");
