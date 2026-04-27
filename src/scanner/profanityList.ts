/**
 * Profanity / blocked-word list for the pre-filter.
 *
 * Words are matched as whole words (word-boundary aware) against the
 * combined token name + ticker + description string.
 * All entries must be lowercase.
 *
 * To block a new word, add it to the appropriate section and restart.
 */

export const PROFANITY: string[] = [
  // Slurs and hate speech
  'nigger', 'nigga', 'faggot', 'fag', 'chink', 'spic', 'kike',
  'tranny', 'retard', 'retarded', 'cunt', 'beaner', 'wetback',
  'gook', 'raghead', 'sandnigger', 'towelhead', 'cracker', 'honky',
  'fart', 'killer',

  // Sexual / graphic
  'fuck', 'fucker', 'fucked', 'fucking', 'motherfucker', 'mf',
  'shit', 'bullshit','baddies',
  'cock', 'dick', 'pussy', 'ass', 'asshole', 'bitch', 'whore',
  'slut', 'cum', 'jizz', 'piss', 'rape', 'rapist',
  'penis', 'vagina', 'anal', 'porn', 'xxx', 'nsfw',
  'sex', 'sexy', 'sexual', 'nude', 'naked', 'boob', 'boobs',
  'tit', 'tits', 'butt', 'butthole', 'dildo', 'hentai', 'onlyfans',
  'escort', 'prostitute', 'hooker',

  // Extreme / illegal / hate
  'pedo', 'pedophile', 'cp', 'loli', 'genocide', 'hitler', 'nazi',
  'terrorist', 'terrorism', 'jihad', 'kkk',

  // Gambling / betting
  'casino', 'gambling', 'gamble', 'gambler', 'betting', 'bettor',
  'poker', 'blackjack', 'roulette', 'slots', 'jackpot', 'wager',
  'sportsbet', 'bookmaker', 'bookie',

  // Alcohol
  'alcohol', 'whiskey', 'whisky', 'vodka', 'tequila', 'bourbon',
  'beer', 'booze', 'drunk', 'drunkard',

  // Drugs (generic + specific)
  'drug', 'drugs', 'narcotic', 'narcotics',
  'weed', 'marijuana', 'cannabis', 'hemp',
  'cocaine', 'heroin', 'meth', 'methamphetamine', 'fentanyl',
  'crack', 'ecstasy', 'mdma', 'lsd', 'ketamine', 'xanax',
  'opioid', 'overdose', 'dealer', 'cartel',

  // Garbage / noise
  'trump', 'biden', 'elon', 'wtf','LMFAO','penis','cuck','crime',
];
