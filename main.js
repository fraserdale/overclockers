var rp = require("request-promise").defaults({
    strictSSL: false,
});

const waitForUserInput = require("wait-for-user-input");
var cheerio = require("cheerio"); // Basically jQuery for node.js
var tough = require("tough-cookie");
const { Webhook, MessageBuilder } = require("discord-webhook-node");

var config = require("./config.json")

const AFK = config.afk;

const host = config.host;
const hostNoHTTP = config.host.split('/')[2];

function makeid(length) {
    var result = [];
    var characters =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result.push(
            characters.charAt(Math.floor(Math.random() * charactersLength))
        );
    }
    return result.join("");
}

var _include_headers = function(body, response, resolveWithFullResponse) {
    return {
        headers: response.headers,
        data: body,
    };
};

const atc = (sku, proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var atcOptions = {
                method: "POST",
                uri: host + "/checkout/addArticle/sTargetAction/cart",
                formData: {
                    sAdd: sku,
                },
                json: true,
                jar: cookiejar,
                transform: _include_headers,
                proxy
            };
            let response = await rp(atcOptions);
            if (response.data.includes("has been added to the basket")) {
                cookie = new tough.Cookie({
                    key: "session",
                    value: response.headers["set-cookie"][0].split(";")[0].split("=")[1],
                    domain: hostNoHTTP,
                    httpOnly: true,
                    maxAge: 31536000,
                });

                cookiejar.setCookie(cookie.toString(), host);

                let respJson = JSON.parse(response.data.split("ArboroGoogleAnalytics('ec:addProduct',")[1].split(");")[0].split("'").join('"'))
                try {
                    respJson['image'] = "https:" + response.data.split('class="thumb_image">')[1].split('>')[0].split('"')[1]
                } catch (e) {
                    respJson['image'] = 'https://www.freepnglogos.com/uploads/paypal-logo-png-2.png'
                    console.log('[ATC] [ERROR] - Couldn\'t get image')
                }

                console.log(
                    "[ATC] [SUCCESS] - Session: ",
                    response.headers["set-cookie"][0].split(";")[0].split("=")[1], " pid ", sku
                );
                resolve(respJson);
            } else {
                throw Error("Not in basket");
            }
        } catch (e) {
            setTimeout(async() => {
                console.log("[ATC] [RETRYING] - ", sku);
                r = await atc(sku, proxy, cookiejar);
                resolve(r);
            }, config.atcMonitorDelay);
        }
    });
};

const postPPGetNonce = (tokenId, mySessionId, myAuthFingerprint, proxy) => {
    return new Promise(async(resolve) => {
        try {
            var ppGetNonce = {
                method: "POST",
                url: "https://api.braintreegateway.com/merchants/wdx2sbmstgw3q86b/client_api/v1/payment_methods/paypal_accounts",
                body: {
                    paypalAccount: {
                        correlationId: tokenId,
                        options: {
                            validate: true,
                        },
                        billingAgreementToken: tokenId,
                    },
                    braintreeLibraryVersion: "braintree/web/3.23.0",
                    _meta: {
                        merchantAppId: "www.overclockers.co.uk",
                        platform: "web",
                        sdkVersion: "3.23.0",
                        source: "client",
                        integration: "custom",
                        integrationType: "custom",
                        sessionId: mySessionId,
                    },
                    authorizationFingerprint: myAuthFingerprint,
                },
                json: true,
                jar: cookiejar,
                proxy
            };


            let jsonNonceResp = await rp(ppGetNonce);
            let paypalNonce = jsonNonceResp.paypalAccounts[0].nonce;

            console.log("[PPGetNonce] [SUCCESS] Nonce: ", paypalNonce);
            resolve(paypalNonce);
        } catch (e) {
            setTimeout(async() => {
                console.log(
                    "[PPGetNonce] [RETRYING] getting PP nonce, payment not yet complete"
                );
                r = await postPPGetNonce(tokenId, mySessionId, myAuthFingerprint, proxy);
                resolve(r);
            }, 10000);
        }
    });
};

const postPPConfirm = (paypalNonce, sid, proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        cookie = new tough.Cookie({
            key: "session",
            value: sid,
            domain: hostNoHTTP,
            httpOnly: true,
            maxAge: 31536000,
        });

        cookiejar.setCookie(cookie.toString(), host);

        var ppconfirm = {
            method: "POST",
            url: host + "/ckBraintree/finish",
            form: {
                paypalNonce: paypalNonce,
                deviceData: `{"correlation_id":${makeid(32)}}`,
            },
            jar: cookiejar,
            proxy
        };
        try {
            let ppConfirmResp = await rp(ppconfirm);

            if (ppConfirmResp.includes("Information on your order")) {
                console.log("[PPConfirm] [SUCCESS] Checkout complete. Check card");
                resolve("Checked out successfully");
            } else {
                throw Error("Payment not found");
            }
        } catch (e) {
            setTimeout(async() => {
                console.log(
                    "[PPConfirm] [RETRYING] posting braintree final confirmation"
                );
                r = await postPPConfirm(paypalNonce, sid, proxy);
                resolve(r);
            }, config.timeout);
        }
    });
};

const getAuthTokens = (proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var authTokens = {
                method: "GET",
                uri: host + "/account/ajax_login",
                transform: function(body, response) {
                    return {
                        headers: response.headers,
                        data: cheerio.load(body),
                    };
                },
                jar: cookiejar,
                proxy
            };
            const response = await rp(authTokens);

            let cookie = new tough.Cookie({
                key: "session",
                value: response.headers["set-cookie"][0].split(";")[0].split("=")[1],
                domain: hostNoHTTP,
                httpOnly: true,
                maxAge: 31536000,
            });

            cookiejar.setCookie(cookie.toString(), host);

            let auth1 = response.data("[name=auth1]").val();
            let auth2 = response.data("[name=auth2]").val();
            let auth3 = response.data("[name=auth3]").val();

            if (!(auth1 && auth2 && auth3)) {
                throw "auth token missing";
            }
            resolve({
                auth1: auth1,
                auth2: auth2,
                auth3: auth3,
                a: cookiejar
            });
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[getAuthTokens] [RETRYING] : retrying get auth");
                const returnedVal = await getAuthTokens(proxy, cookiejar);
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};

const login = (auth1, auth2, auth3, email, password, proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var loginOptions = {
                method: "POST",
                url: host + "/account/ajax_login",
                headers: {
                    //'authority': 'www.overclockers.co.uk',
                    pragma: "no-cache",
                    "cache-control": "no-cache",
                    "sec-ch-ua": '" Not A;Brand";v="99", "Chromium";v="90", "Google Chrome";v="90"',
                    accept: "*/*",
                    "x-requested-with": "XMLHttpRequest",
                    "sec-ch-ua-mobile": "?0",
                    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.72 Safari/537.36",
                    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
                    //'origin': 'www.overclockers.co.uk',
                    "sec-fetch-site": "same-origin",
                    "sec-fetch-mode": "cors",
                    "sec-fetch-dest": "empty",
                    //'referer': 'https://www.overclockers.co.uk/gaming/gaming-chairs/asus',
                    "accept-language": "en-US,en;q=0.9",
                    //'host': 'www.overclockers.co.uk'
                },
                body: `accountmode=2&email=${encodeURI(
          email
        )}&auth1=${auth1}&auth2=${auth2}&auth3=${auth3}&password=${password}`,
                transform: _include_headers,
                jar: cookiejar,
                proxy
            };
            let response = await rp(loginOptions);
            if (response.headers["set-cookie"].length == 3) {
                cookie = new tough.Cookie({
                    key: "session",
                    value: response.headers["set-cookie"][1].split(";")[0].split("=")[1],
                    domain: hostNoHTTP,
                    httpOnly: true,
                    maxAge: 31536000,
                });

                cookiejar.setCookie(cookie.toString(), host);
            } else {
                throw "incorrect number of login cookies";
            }
            console.log("[LOGIN] [SUCCESS] - " + email);
            resolve(cookiejar);
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[LOGIN] [RETRYING]");
                const returnedVal = await login(auth1, auth2, auth3, email, password, proxy, cookiejar);
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};

const visitCheckout = (proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var visitCheckoutOptions = {
                method: "GET",
                uri: host + "/checkout/confirm",
                jar: cookiejar,
                transform: _include_headers,

                proxy
            };
            //const resp = await rp(options);
            const response = await rp(visitCheckoutOptions);
            let sid = response.headers["set-cookie"][0].split(";")[0].split("=")[1];
            cookie = new tough.Cookie({
                key: "session",
                value: sid,
                domain: hostNoHTTP,
                httpOnly: true,
                maxAge: 31536000,
            });

            cookiejar.setCookie(cookie.toString(), host);
            console.log("[VisitCheckout] [SUCCESS]");
            resolve({ sessionid: sid, b: cookiejar });
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[VisitCheckout] [RETRYING]");
                const returnedVal = await visitCheckout(proxy, cookiejar);
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};

const getPPPage = (proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var getPPPageOptions = {
                method: "GET",
                uri: host + "/ck_braintree/payment_paypal",
                jar: cookiejar,
                proxy
            };
            let body = await rp(getPPPageOptions);

            let buff = new Buffer.from(
                body.split("var clientToken = '")[1].split("'")[0],
                "base64"
            );
            let decodedToken = JSON.parse(buff.toString("ascii"));

            const { v4: uuidv4 } = require("uuid");
            var vals = {
                mySessionId: uuidv4(),
                myAuthFingerprint: decodedToken.authorizationFingerprint,
                cookiejar
            };
            console.log("[getPPPage] [SUCCESS] ");
            resolve(vals);
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[getPPPage] [RETRYING]");
                const returnedVal = await getPPPage(proxy, cookiejar);
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};

const getPPLink = (mySessionId, myAuthFingerprint, proxy, cookiejar) => {
    return new Promise(async(resolve) => {
        try {
            var getPPLinkOptions = {
                method: "POST",
                uri: "https://api.braintreegateway.com/merchants/wdx2sbmstgw3q86b/client_api/v1/paypal_hermes/setup_billing_agreement",
                body: {
                    returnUrl: "https://checkout.paypal.com/web/3.23.0/html/paypal-redirect-frame.min.html?channel=efb6732037de4c27b51d6a2424c8ed3f",
                    cancelUrl: "https://checkout.paypal.com/web/3.23.0/html/paypal-cancel-frame.min.html?channel=efb6732037de4c27b51d6a2424c8ed3f",
                    offerPaypalCredit: false,
                    experienceProfile: {
                        brandName: "Overclockers UK",
                        localeCode: "en_GB",
                        noShipping: "true",
                        addressOverride: false,
                    },
                    braintreeLibraryVersion: "braintree/web/3.23.0",
                    _meta: {
                        merchantAppId: "www.overclockers.co.uk",
                        platform: "web",
                        sdkVersion: "3.23.0",
                        source: "client",
                        integration: "custom",
                        integrationType: "custom",
                        sessionId: mySessionId,
                    },
                    authorizationFingerprint: myAuthFingerprint,
                },
                json: true,
                jar: cookiejar,
                proxy
            };
            let jsonResp = await rp(getPPLinkOptions);

            console.log("[getPPLink] [SUCCESS] - ", jsonResp.agreementSetup.approvalUrl);

            resolve({
                url: jsonResp.agreementSetup.approvalUrl,
                token: jsonResp.agreementSetup.tokenId,
                cookiejar
            });
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[getPPLink] [RETRYING]");
                const returnedVal = await getPPLink(mySessionId, myAuthFingerprint, proxy, cookiejar);
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};

const broadcastURL = (url, sku, webhookURL, product) => {
    return new Promise(async(resolve) => {
        try {
            const hook = new Webhook(
                webhookURL
            );

            const embed = new MessageBuilder()
                .setTitle(product.name + " - " + sku)
                .setURL(url)
                .setColor("#3B7BBF")
                .setDescription(
                    "Click link above to checkout"
                )
                .addField('Checkout method', 'PayPal', true)
                .addField('Price', '£' + product.price, true)
                .setThumbnail(product.image)
                .setTimestamp();

            hook.send(embed);
            console.log("[broadcast] [SUCCESSFUL] " + sku);

            resolve();
        } catch (e) {
            setTimeout(async() => {
                console.log("[broadcastURL] [RETRYING]");
                r = await broadcastURL(url, sku);
                resolve(r);
            }, config.timeout);
        }
    });
};

const broadcastSuccess = (webhookURL, product, email) => {
    return new Promise(async(resolve) => {
        try {
            const hook = new Webhook(
                webhookURL
            );

            const embed = new MessageBuilder()
                .setTitle(product.name + " - " + sku)
                .setColor("#00FF00")
                .setDescription(
                    "Successfully checked out"
                )
                .addField('Account', '||' + email + '||', true)
                .addField('Price', '£' + product.price, true)
                .setThumbnail(product.image)
                .setTimestamp();

            hook.send(embed);
            console.log("[broadcast Success] [SUCCESSFUL] " + sku);

            resolve();
        } catch (e) {
            setTimeout(async() => {
                console.log("[broadcast Success] [RETRYING]");
                r = await broadcastURL(url, sku);
                resolve(r);
            }, config.timeout);
        }
    });
};

const getProducts = (link) => {
    return new Promise(async(resolve) => {
        try {
            var getProductsOptions = {
                method: "GET",
                uri: host + link,
                transform: function(body, response) {
                    return cheerio.load(body)

                },
            };
            let body = await rp(getProductsOptions);
            toRet = []
            body('input[class="ArboroGoogleAnalyticsProductOrderNr"]').each((a, b) => {
                toRet.push(body(b).val())
            })
            resolve(toRet);
        } catch (e) {
            //e.statusCode
            setTimeout(async() => {
                console.log("[getPPPage] [RETRYING]");
                const returnedVal = await getPPPage();
                resolve(returnedVal);
            }, config.timeout);
        }
    });
};



async function main() {
    let skus = []
    var fs = require("fs");
    var proxiesText = fs.readFileSync("./proxies.txt", "utf-8");
    var proxies = proxiesText.split("\r\n")


    const promises = config.links.map(getProducts);
    // wait until all promises are resolved
    skus.push(await Promise.all(promises));

    skus = skus.flat(2)

    console.log(skus)

    console.log(skus.length)

    /* if (skus.length < config.accounts.length) {
        config.accounts.slice(0, config.skus.length)
    } */

    let proxyCounter = 0
    skus.forEach(async(sku) => {
        var cookiejar = rp.jar();

        let accnum = 0
        accnum = skus.indexOf(sku) % config.accounts.length


        let proxy = proxies[proxyCounter]
        proxyCounter++
        if (proxyCounter == 25) proxyCounter = 0
        console.log(proxy)
        const { auth1, auth2, auth3, a } = await getAuthTokens(proxy, cookiejar);
        cookiejar = a
        cookiejar = await login(auth1, auth2, auth3, config.accounts[accnum].email, config.accounts[accnum].password, proxy, cookiejar);
        let added = await atc(sku, proxy, cookiejar);
        console.log('[PRODUCT] - ' + added.name)
        let { sessionid } = await visitCheckout(proxy, cookiejar);
        const { mySessionId, myAuthFingerprint } = await getPPPage(proxy, cookiejar);

        const { url, token } = await getPPLink(mySessionId, myAuthFingerprint, proxy, cookiejar);

        await broadcastURL(url, sku, config.webhookURL, added);
        if (!AFK) {
            await waitForUserInput("Press enter when paypal complete");
        }
        let paypalNonce = await postPPGetNonce(token, mySessionId, myAuthFingerprint, proxy, cookiejar);
        await postPPConfirm(paypalNonce, sessionid, proxy, cookiejar);
        await broadcastSuccess(onfig.webhookURL, added, config.accounts[accnum].email)
    })
}

main();