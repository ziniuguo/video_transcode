const Cognito = require("@aws-sdk/client-cognito-identity-provider");

const clientId = "2olhmm2tshjpl097ncers3h5kq";  // New Client ID from the AWS console
const username = "Aa123456.";  // Replace with the desired username
const password = "Aa123456.";  // Replace with a valid password that meets Cognito requirements
const email = "Aa123456@example.com";  // Replace with the email address to receive the confirmation code

async function main() {
  console.log("Signing up user");
  const client = new Cognito.CognitoIdentityProviderClient({ region: 'ap-southeast-2' });

  // Cognito Sign Up Command
  const command = new Cognito.SignUpCommand({
    ClientId: clientId,
    Username: username,
    Password: password,
    UserAttributes: [{ Name: "email", Value: email }],
  });

  try {
    const res = await client.send(command);
    console.log("User signed up successfully:", res);
  } catch (error) {
    console.error("Error signing up user:", error);
  }
}

main();
