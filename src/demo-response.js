function generateDemoResponse(input) {
  const responses = [
    "Hmm, that's interesting. Tell me more!",
    "I'm just a demo bot, but I heard you loud and clear.",
    "Tubs is online and vibing. What else you got?",
    "Cool cool cool. I'm processing that with my massive brain.",
    "Beep boop. That's robot for 'I agree'.",
    "You know what, that's a great point.",
    "I'm nodding enthusiastically. Can you tell?",
    "Filing that under 'important thoughts'. Done.",
  ];
  return responses[Math.floor(Math.random() * responses.length)];
}

module.exports = { generateDemoResponse };
